/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { IpcMainInvokeEvent } from "electron";

const execFileAsync = promisify(execFile);

interface EmojiRef {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
    readonly url: string;
}

interface NotificationPayload {
    readonly title: string;
    readonly body: string;
    readonly icon: string;
    readonly messageId: string;
    readonly channelId: string;
    readonly guildId?: string;
    readonly authorId: string;
    readonly authorName: string;
    readonly emojis: readonly EmojiRef[];
}

/** Escape backslashes and single quotes for GVariant text format string values */
function escapeGVariant(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function sendNotification(
    _: IpcMainInvokeEvent,
    payload: NotificationPayload
): Promise<void> {
    const meta = escapeGVariant(JSON.stringify({
        messageId: payload.messageId,
        channelId: payload.channelId,
        guildId: payload.guildId,
        authorId: payload.authorId,
        authorName: payload.authorName,
        icon: payload.icon,
        emojis: payload.emojis
    }));

    await execFileAsync("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications",
        "--method", "org.freedesktop.Notifications.Notify",
        "Discord",
        "0",
        "",
        payload.title,
        payload.body,
        "[]",
        `{'x-discord-rich': <'${meta}'>}`,
        "5000"
    ]);
}
