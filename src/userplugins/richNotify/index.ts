/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.RichNotify as PluginNative<typeof import("./native")>;
const logger = new Logger("RichNotify");

const CUSTOM_EMOJI_REGEX = /<a?:(\w+)(?:~\d+)?:(\d+)>/g;

interface EmojiRef {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
    readonly url: string;
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
        ]
    }
});

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
            url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=${size}&quality=lossless`
        });
    }

    return emojis;
}

export default definePlugin({
    name: "RichNotify",
    description: "Replaces Discord's desktop notifications with rich freedesktop dbus notifications, embedding message metadata and emoji URLs for any notification tool to consume.",
    authors: [{ name: "dotBeeps", id: 130151971431776256n }],
    settings,

    patches: [
        {
            find: ".getDesktopType()===",
            replacement: {
                match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)(?=.*?\i\.\i\.playNotificationSound)/,
                replace: "$1||$self.shouldSuppress())"
            }
        }
    ],

    shouldSuppress: () => true,

    flux: {
        async RPC_NOTIFICATION_CREATE({ title, body, icon, message }: RpcNotificationDispatch) {
            if (!message) return;

            const size = settings.store.emojiSize;
            const content = message.content ?? body;
            const emojis = extractEmojis(content, size);

            try {
                await Native.sendNotification({
                    title,
                    body,
                    icon,
                    messageId: message.id,
                    channelId: message.channel_id,
                    guildId: message.guild_id,
                    authorId: message.author.id,
                    authorName: message.author.global_name ?? message.author.username,
                    emojis
                });
            } catch (error) {
                logger.error("Failed to send notification:", error);
            }
        }
    }
});
