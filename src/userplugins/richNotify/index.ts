/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, GuildStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.RichNotify as PluginNative<
    typeof import("./native")
>;
const logger = new Logger("RichNotify");

const CUSTOM_EMOJI_REGEX = /<a?:(\w+)(?:~\d+)?:(\d+)>/g;

interface EmojiRef {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
    readonly url: string;
}

interface StickerInfo {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly animated: boolean;
}

interface AttachmentInfo {
    readonly url: string;
    readonly width?: number;
    readonly height?: number;
}

interface EmbedInfo {
    readonly imageUrl?: string;
    readonly title?: string;
    readonly description?: string;
    readonly color?: number;
}

interface RpcNotificationDispatch {
    readonly title: string;
    readonly body: string;
    readonly icon: string;
    readonly message?: {
        readonly id: string;
        readonly channel_id: string;
        readonly guild_id?: string;
        readonly content?: string;
        readonly author: {
            readonly id: string;
            readonly username: string;
            readonly global_name?: string;
        };
        readonly stickerItems?: ReadonlyArray<{
            readonly id: string;
            readonly name: string;
            readonly format_type: number;
        }>;
        readonly attachments?: ReadonlyArray<{
            readonly url: string;
            readonly proxy_url: string;
            readonly filename: string;
            readonly content_type?: string;
            readonly width?: number;
            readonly height?: number;
        }>;
        readonly embeds?: ReadonlyArray<{
            readonly title?: string;
            readonly description?: string;
            readonly color?: number;
            readonly image?: { readonly url: string };
            readonly thumbnail?: { readonly url: string };
        }>;
    };
}

const settings = definePluginSettings({
    emojiSize: {
        type: OptionType.SELECT,
        description: "Size of emoji images included in notification metadata.",
        options: [
            { label: "48px", value: 48 },
            { label: "64px", value: 64 },
            { label: "96px", value: 96, default: true },
            { label: "128px", value: 128 },
        ],
    },
    suppressDefault: {
        type: OptionType.BOOLEAN,
        description: "Suppress Discord's built-in desktop notifications.",
        default: true,
        restartNeeded: true,
    },
    appName: {
        type: OptionType.STRING,
        description: "Application name sent with the DBus notification.",
        default: "Discord",
    },
    timeout: {
        type: OptionType.NUMBER,
        description:
            "Notification display duration in milliseconds. Use 0 for the daemon default.",
        default: 5000,
    },
});

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

const DISCORD_CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net"];

function forceGifFormat(url: string): string {
    try {
        const parsed = new URL(url);
        if (!DISCORD_CDN_HOSTS.some(h => parsed.hostname === h)) return url;
        parsed.searchParams.set("format", "gif");
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Convert Discord-flavored markdown to a Qt RichText-compatible HTML subset.
 * Emoji syntax (<a?:name:id>) is preserved via placeholder round-trip so it
 * survives HTML escaping and remains parseable by DiscordBody in the shell.
 */
function convertMarkdown(text: string): string {
    // Round-trip emoji syntax through placeholders so escapeHtml doesn't corrupt it.
    const emojiSlots: string[] = [];
    let out = text.replace(/<(a?):(\w+)(?:~\d+)?:(\d+)>/g, (match) => {
        const idx = emojiSlots.length;
        emojiSlots.push(match);
        return `\x00E${idx}\x00`;
    });

    // Escape remaining HTML special chars.
    out = escapeHtml(out);

    // Code blocks before anything else to prevent inner processing.
    out = out.replace(
        /```(?:\w+\n)?([\s\S]*?)```/g,
        (_, code) => `<pre><code>${code.trim()}</code></pre>`,
    );
    // Inline code.
    out = out.replace(/`([^\n`]+)`/g, "<code>$1</code>");
    // Bold+italic ***.
    out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
    // Bold **.
    out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    // Underline __ (before italic _ to avoid false matches).
    out = out.replace(/__(.+?)__/g, "<u>$1</u>");
    // Italic * or _.
    out = out.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
    out = out.replace(/_([^_\n]+)_/g, "<i>$1</i>");
    // Strikethrough.
    out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");
    // Spoiler — render as dim bracketed text (no interactivity in shell).
    out = out.replace(
        /\|\|(.+?)\|\|/g,
        '<font color="#666666">[spoiler]</font>',
    );
    // Blockquotes (line-start only).
    out = out.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    // Newlines to <br>.
    out = out.replace(/\n/g, "<br>");

    // Restore emoji syntax.
    out = out.replace(/\x00E(\d+)\x00/g, (_, i) => emojiSlots[+i]);

    return out;
}

function extractAttachments(
    msg: NonNullable<RpcNotificationDispatch["message"]>,
): AttachmentInfo[] {
    return (msg.attachments ?? [])
        .filter((a) => a.content_type?.startsWith("image/"))
        .slice(0, 4)
        .map((a) => ({
            url: a.content_type === "image/gif" ? forceGifFormat(a.proxy_url) : a.proxy_url,
            width: a.width,
            height: a.height,
        }));
}

function extractEmojis(content: string, size: number): EmojiRef[] {
    const emojis: EmojiRef[] = [];
    const seen = new Set<string>();

    CUSTOM_EMOJI_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = CUSTOM_EMOJI_REGEX.exec(content)) !== null) {
        const id = match[2];
        if (seen.has(id)) continue;
        seen.add(id);

        const animated = match[0].startsWith("<a:");
        emojis.push({
            id,
            name: match[1],
            animated,
            url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=${size}&quality=lossless`,
        });
    }

    return emojis;
}

function extractSticker(
    msg: NonNullable<RpcNotificationDispatch["message"]>,
): StickerInfo | null {
    const sticker = msg.stickerItems?.[0];
    if (!sticker) return null;

    const formatType = sticker.format_type ?? 1;
    if (formatType === 3) return null; // Lottie — can't render in QML

    const animated = formatType === 2 || formatType === 4;
    const ext = animated ? "gif" : "png";

    return {
        id: sticker.id,
        name: sticker.name,
        url: `https://media.discordapp.net/stickers/${sticker.id}.${ext}`,
        animated,
    };
}

function extractEmbed(
    msg: NonNullable<RpcNotificationDispatch["message"]>,
): EmbedInfo | null {
    const embed = msg.embeds?.[0];
    if (!embed) return null;

    const rawImageUrl = embed.image?.url ?? embed.thumbnail?.url;
    const imageUrl = rawImageUrl ? forceGifFormat(rawImageUrl) : undefined;
    const title = embed.title ? embed.title.slice(0, 80) : undefined;
    const description = embed.description
        ? embed.description.slice(0, 200)
        : undefined;

    if (!imageUrl && !title && !description) return null;

    return {
        imageUrl,
        title,
        description,
        color: typeof embed.color === "number" ? embed.color : undefined,
    };
}

function buildHints(
    dispatch: RpcNotificationDispatch,
    emojis: EmojiRef[],
    bodyHtml: string,
): Record<string, string> {
    const hints: Record<string, string> = {};
    const msg = dispatch.message;

    if (dispatch.icon) hints["x-quickshell-icon-url"] = dispatch.icon;

    hints["x-quickshell-body-html"] = bodyHtml;

    if (msg) {
        if (msg.guild_id) {
            hints["x-quickshell-guild-id"] = msg.guild_id;
            const guild = GuildStore.getGuild(msg.guild_id);
            if (guild?.name) hints["x-quickshell-guild-name"] = guild.name;
        }

        if (msg.channel_id) {
            hints["x-quickshell-channel-id"] = msg.channel_id;
            const channel = ChannelStore.getChannel(msg.channel_id);
            if (channel?.name)
                hints["x-quickshell-channel-name"] = channel.name;
        }

        if (msg.id) hints["x-quickshell-message-id"] = msg.id;

        if (msg.author) {
            hints["x-quickshell-author-id"] = msg.author.id;
            hints["x-quickshell-author-name"] =
                msg.author.global_name ?? msg.author.username;
        }

        const sticker = extractSticker(msg);
        if (sticker) hints["x-quickshell-sticker"] = JSON.stringify(sticker);

        const embed = extractEmbed(msg);
        if (embed) hints["x-quickshell-embed"] = JSON.stringify(embed);

        const attachments = extractAttachments(msg);
        if (attachments.length)
            hints["x-quickshell-images"] = JSON.stringify(attachments);
    }

    if (emojis.length) hints["x-quickshell-emojis"] = JSON.stringify(emojis);

    return hints;
}

export default definePlugin({
    name: "RichNotify",
    description:
        "Sends Discord notifications over freedesktop DBus with rich metadata, emoji CDN URLs, stickers, and embed previews for quickshell or other notification daemons.",
    authors: [{ name: "dotBeeps", id: 130151971431776256n }],
    settings,

    patches: [
        {
            find: ".getDesktopType()===",
            replacement: {
                match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)(?=.*?\i\.\i\.playNotificationSound)/,
                replace: "$1||$self.shouldSuppress())",
            },
        },
    ],

    shouldSuppress() {
        return settings.store.suppressDefault;
    },

    flux: {
        async RPC_NOTIFICATION_CREATE({
            title,
            body,
            icon,
            message,
        }: RpcNotificationDispatch) {
            const size = settings.store.emojiSize;
            const content = message?.content ?? body;
            const emojis = extractEmojis(content, size);
            const bodyHtml = convertMarkdown(content);
            const hints = buildHints(
                { title, body, icon, message },
                emojis,
                bodyHtml,
            );

            try {
                await Native.sendNotification({
                    appName: settings.store.appName,
                    title,
                    body,
                    iconUrl: icon,
                    hints,
                    timeout: settings.store.timeout,
                });
            } catch (error) {
                logger.error("Failed to send notification:", error);
            }
        },
    },
});
