# RichNotify Media Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs in the RichNotify plugin: custom emoji rendering as `:name:` text, stickers not appearing, and animated images not playing.

**Architecture:** The existing hint-based DBus pipeline is sound. We add debug logging to identify root causes for emoji and sticker issues, apply a confident animation URL fix immediately, then apply targeted fixes for emoji and stickers based on debug findings. All changes are in `src/userplugins/richNotify/index.ts`.

**Tech Stack:** TypeScript, Equicord/Vencord plugin API, freedesktop DBus notifications, Qt Quick (consumer side)

---

### Task 1: Add debug logging to the flux handler

Instrument the `RPC_NOTIFICATION_CREATE` handler to dump the exact payload shape. This reveals the root cause for emoji and sticker issues.

**Files:**

- Modify: `src/userplugins/richNotify/index.ts:317-347` (flux handler)

- [ ] **Step 1: Add payload inspection logging before extraction**

Add logging at the top of the flux handler, before extraction calls. Log the raw dispatch fields to understand what Discord actually sends.

In `src/userplugins/richNotify/index.ts`, inside the `RPC_NOTIFICATION_CREATE` handler, add after the destructuring (after line 323) and before the extraction logic (before line 324):

```typescript
logger.info("=== RPC_NOTIFICATION_CREATE ===");
logger.info("body (first 200):", body?.slice(0, 200));
logger.info("message present:", !!message);
if (message) {
    logger.info("message keys:", Object.keys(message).join(", "));
    logger.info("message.content (first 200):", message.content?.slice(0, 200));
    logger.info("stickerItems:", JSON.stringify(message.stickerItems));
    logger.info(
        "sticker_items:",
        JSON.stringify((message as any).sticker_items),
    );
    logger.info("attachments count:", message.attachments?.length ?? 0);
    if (message.attachments?.[0]) {
        logger.info(
            "first attachment:",
            JSON.stringify({
                content_type: message.attachments[0].content_type,
                proxy_url: message.attachments[0].proxy_url?.slice(0, 100),
            }),
        );
    }
    logger.info("embeds count:", message.embeds?.length ?? 0);
    if (message.embeds?.[0]) {
        logger.info(
            "first embed image:",
            message.embeds[0].image?.url?.slice(0, 100),
        );
        logger.info(
            "first embed thumbnail:",
            message.embeds[0].thumbnail?.url?.slice(0, 100),
        );
    }
}
```

- [ ] **Step 2: Add post-extraction logging**

After the extraction calls (after `const hints = buildHints(...)`, around line 333), add:

```typescript
logger.info(
    "extracted emojis:",
    emojis.length,
    emojis[0] ? JSON.stringify(emojis[0]) : "none",
);
logger.info("bodyHtml (first 200):", bodyHtml.slice(0, 200));
logger.info("hint keys:", Object.keys(hints).join(", "));
if (hints["x-quickshell-sticker"])
    logger.info("sticker hint:", hints["x-quickshell-sticker"]);
if (hints["x-quickshell-emojis"])
    logger.info(
        "emojis hint (first 200):",
        hints["x-quickshell-emojis"].slice(0, 200),
    );
```

- [ ] **Step 3: Build and test logging**

Run: `pnpm build` (or however the local build works)
Trigger a notification in Discord containing a custom emoji. Check the Equicord console (Ctrl+Shift+I > Console) for the `[RichNotify]` log lines.

Record what you see for:

1. Does `message.content` contain `<a:name:id>` or `:name:` syntax?
2. Is `stickerItems` or `sticker_items` populated?
3. Are the extracted emoji count and hint keys what you expect?

- [ ] **Step 4: Commit debug logging**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "debug: add payload inspection logging to RichNotify flux handler"
```

---

### Task 2: Fix animated image URLs for Qt compatibility

Qt's `AnimatedImage` reliably animates GIF but not WebP. Discord CDN often serves WebP by default. Force GIF format on Discord CDN URLs where animation is expected. This fix is independent of debug findings.

**Files:**

- Modify: `src/userplugins/richNotify/index.ts:171-178` (extractAttachments)
- Modify: `src/userplugins/richNotify/index.ts:224-244` (extractEmbed)
- Modify: `src/userplugins/richNotify/index.ts:204-222` (extractSticker)

- [ ] **Step 1: Add a Discord CDN URL rewriter**

Add this function after `escapeHtml` (after line 118) in `src/userplugins/richNotify/index.ts`:

```typescript
const DISCORD_CDN_HOSTS = [
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net",
];

function forceGifFormat(url: string): string {
    try {
        const parsed = new URL(url);
        if (!DISCORD_CDN_HOSTS.some((h) => parsed.hostname === h)) return url;
        parsed.searchParams.set("format", "gif");
        return parsed.toString();
    } catch {
        return url;
    }
}
```

- [ ] **Step 2: Apply to attachment extraction**

In `extractAttachments` (line 171-178), update the map to force GIF on animated content types:

Change:

```typescript
.map((a) => ({ url: a.proxy_url, width: a.width, height: a.height }));
```

To:

```typescript
.map((a) => ({
    url: a.content_type === "image/gif" ? forceGifFormat(a.proxy_url) : a.proxy_url,
    width: a.width,
    height: a.height,
}));
```

- [ ] **Step 3: Apply to embed extraction**

In `extractEmbed` (around line 229), update the imageUrl assignment:

Change:

```typescript
const imageUrl = embed.image?.url ?? embed.thumbnail?.url;
```

To:

```typescript
const rawImageUrl = embed.image?.url ?? embed.thumbnail?.url;
const imageUrl = rawImageUrl ? forceGifFormat(rawImageUrl) : undefined;
```

- [ ] **Step 4: Fix sticker APNG URL to request GIF**

In `extractSticker` (around line 215-216), change the extension logic so APNG stickers also request GIF format from Discord (Discord can serve stickers in multiple formats):

Change:

```typescript
const animated = formatType === 2 || formatType === 4;
const ext = formatType === 4 ? "gif" : "png";
```

To:

```typescript
const animated = formatType === 2 || formatType === 4;
const ext = animated ? "gif" : "png";
```

This means format_type 2 (APNG) now gets `.gif` instead of `.png`, since Discord's CDN can serve the same sticker as GIF.

- [ ] **Step 5: Commit animation fixes**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "fix: force GIF format on Discord CDN URLs for Qt AnimatedImage compatibility"
```

---

### Task 3: Fix emoji extraction and hint delivery

This task addresses custom emoji showing as `:name:` text. The fix depends on what Task 1 logging reveals. Below are the three scenarios with concrete fixes for each. **Apply whichever matches your debug output.**

**Files:**

- Modify: `src/userplugins/richNotify/index.ts:7-10` (imports)
- Modify: `src/userplugins/richNotify/index.ts:180-200` (extractEmojis)
- Modify: `src/userplugins/richNotify/index.ts:324-326` (content selection)

#### Scenario A: `message.content` has raw `<a:name:id>` syntax but emojis hint is empty or corrupt

This means extraction works but the data is lost in transport. Most likely the GVariant escaping corrupts the JSON.

- [ ] **Step A1: Check if the emojis hint JSON contains characters that break GVariant**

Look at the debug log for `emojis hint`. If it contains backslashes or single quotes that got double-escaped, the issue is in `escapeGVariant`. The emoji URL contains `?size=96&quality=lossless` — the `&` is fine for GVariant but check if the full hint value round-trips correctly.

- [ ] **Step A2: If GVariant is the issue, simplify the emoji JSON**

URL-encode the emoji URLs before JSON.stringify to avoid special characters:

In `extractEmojis`, change the URL construction (line 197):

```typescript
url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=${size}&quality=lossless`,
```

To:

```typescript
url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=${size}`,
```

(Drop `&quality=lossless` — it's unnecessary for notification-sized emoji and reduces URL complexity through the GVariant pipeline.)

#### Scenario B: `message.content` is empty/undefined, `body` has `:name:` format

The emoji names are in `:name:` format with no IDs. Use `EmojiStore` to look up emoji by name.

- [ ] **Step B1: Import EmojiStore and MessageStore**

In `src/userplugins/richNotify/index.ts`, update the import on line 10:

Change:

```typescript
import { ChannelStore, GuildStore } from "@webpack/common";
```

To:

```typescript
import {
    ChannelStore,
    EmojiStore,
    GuildStore,
    MessageStore,
} from "@webpack/common";
```

- [ ] **Step B2: Add a fallback emoji lookup from the full message**

Add a new function after `extractEmojis` (after line 200):

```typescript
function extractEmojisFromMessage(
    channelId: string,
    messageId: string,
    size: number,
): EmojiRef[] {
    const fullMsg = MessageStore.getMessage(channelId, messageId);
    if (!fullMsg?.content) return [];
    return extractEmojis(fullMsg.content, size);
}
```

- [ ] **Step B3: Update the flux handler to use the fallback**

In the flux handler (around line 324-326), change:

```typescript
const size = settings.store.emojiSize;
const content = message?.content ?? body;
const emojis = extractEmojis(content, size);
```

To:

```typescript
const size = settings.store.emojiSize;
const content = message?.content || body;
let emojis = extractEmojis(content, size);
if (!emojis.length && message?.channel_id && message?.id) {
    emojis = extractEmojisFromMessage(message.channel_id, message.id, size);
}
```

Note: changed `??` to `||` so empty string content falls through to body.

- [ ] **Step B4: Also use full message content for bodyHtml if needed**

After the emoji fallback, update bodyHtml to use whichever source had the raw emoji syntax:

```typescript
const rawContent = emojis.length
    ? (MessageStore.getMessage(message?.channel_id ?? "", message?.id ?? "")
          ?.content ?? content)
    : content;
const bodyHtml = convertMarkdown(rawContent);
```

#### Scenario C: Both fields have `:name:` format (no raw syntax anywhere)

- [ ] **Step C1: Use EmojiStore to resolve `:name:` to CDN URLs**

Add a new extraction function after `extractEmojis`:

```typescript
const COLON_EMOJI_REGEX = /:(\w+):/g;

function extractEmojisByName(content: string, size: number): EmojiRef[] {
    const emojis: EmojiRef[] = [];
    const seen = new Set<string>();

    COLON_EMOJI_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = COLON_EMOJI_REGEX.exec(content)) !== null) {
        const name = match[1];
        if (seen.has(name)) continue;

        const results = EmojiStore.searchWithoutFetchingLatest({
            query: name,
            count: 1,
        });
        const emoji = results?.unlocked?.[0];
        if (!emoji?.id) continue;

        seen.add(name);
        emojis.push({
            id: emoji.id,
            name: emoji.name ?? name,
            animated: emoji.animated ?? false,
            url: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=${size}`,
        });
    }

    return emojis;
}
```

Then in the flux handler, add after the existing emoji extraction:

```typescript
if (!emojis.length) {
    emojis = extractEmojisByName(content, size);
}
```

- [ ] **Step 4: Commit emoji fix (whichever scenario applied)**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "fix: resolve custom emoji extraction for notification rendering"
```

---

### Task 4: Fix sticker extraction

This task addresses stickers not appearing. Depends on Task 1 debug output.

**Files:**

- Modify: `src/userplugins/richNotify/index.ts:7-10` (imports, if not already updated in Task 3)
- Modify: `src/userplugins/richNotify/index.ts:204-222` (extractSticker)

#### Scenario A: `stickerItems` is undefined but `sticker_items` exists (field name mismatch)

Discord's internal API uses `sticker_items` (snake_case) but the RPC dispatch might not camelCase it.

- [ ] **Step A1: Update extractSticker to check both field names**

In `extractSticker` (line 205), change:

```typescript
const sticker = msg.stickerItems?.[0];
```

To:

```typescript
const sticker = msg.stickerItems?.[0] ?? (msg as any).sticker_items?.[0];
```

- [ ] **Step A2: Also update the RpcNotificationDispatch interface**

Add the snake_case variant to the message interface (around line 60):

```typescript
readonly sticker_items?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly format_type: number;
}>;
```

#### Scenario B: Neither field exists on the dispatch message

The sticker data isn't in the notification dispatch at all. Use `MessageStore` to get the full message.

- [ ] **Step B1: Ensure MessageStore import exists**

If not already added in Task 3, update the import on line 10:

```typescript
import { ChannelStore, GuildStore, MessageStore } from "@webpack/common";
```

- [ ] **Step B2: Add a MessageStore fallback to extractSticker**

Change the function signature and add a fallback:

```typescript
function extractSticker(
    msg: NonNullable<RpcNotificationDispatch["message"]>,
): StickerInfo | null {
    const sticker = msg.stickerItems?.[0] ?? (msg as any).sticker_items?.[0];
    if (!sticker) {
        const fullMsg = MessageStore.getMessage(msg.channel_id, msg.id);
        const storeStickerItems =
            fullMsg?.stickerItems ?? fullMsg?.sticker_items;
        const storeSticker = storeStickerItems?.[0];
        if (!storeSticker) return null;
        return buildStickerInfo(storeSticker);
    }
    return buildStickerInfo(sticker);
}

function buildStickerInfo(sticker: {
    id: string;
    name: string;
    format_type?: number;
}): StickerInfo | null {
    const formatType = sticker.format_type ?? 1;
    if (formatType === 3) return null;

    const animated = formatType === 2 || formatType === 4;
    const ext = animated ? "gif" : "png";

    return {
        id: sticker.id,
        name: sticker.name,
        url: `https://media.discordapp.net/stickers/${sticker.id}.${ext}`,
        animated,
    };
}
```

#### Scenario C: Sticker data exists but the URL 404s

- [ ] **Step C1: Verify sticker CDN URL format**

Open a browser and test `https://media.discordapp.net/stickers/{STICKER_ID}.png` with a real sticker ID from the debug logs. If it 404s, try:

- `https://cdn.discordapp.com/stickers/{STICKER_ID}.png`
- `https://media.discordapp.net/stickers/{STICKER_ID}.png?size=160`

Update the URL template in `buildStickerInfo` (or `extractSticker`) to match whichever works.

- [ ] **Step 4: Commit sticker fix**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "fix: resolve sticker extraction for notification rendering"
```

---

### Task 5: Remove debug logging

After all fixes are confirmed working, strip the temporary logging added in Task 1.

**Files:**

- Modify: `src/userplugins/richNotify/index.ts` (flux handler)

- [ ] **Step 1: Remove all `logger.info` calls added in Task 1**

Delete the two logging blocks added in Steps 1 and 2 of Task 1 (the `=== RPC_NOTIFICATION_CREATE ===` block and the post-extraction block). Keep the existing `logger.error` in the catch block.

- [ ] **Step 2: Commit cleanup**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "chore: remove debug logging from RichNotify flux handler"
```

---

### Task 6: Manual verification

Trigger notifications for each content type and verify rendering in QuickShell.

- [ ] **Step 1: Test custom emoji**

Send a message containing custom emoji (both animated and static) in a channel you'll receive notifications for. Verify:

- Emoji renders as inline images in the notification toast, not as `:name:` text
- Animated emoji animate (GIF plays)
- Static emoji display correctly

- [ ] **Step 2: Test stickers**

Send sticker-only messages (PNG sticker, APNG sticker, GIF sticker). Verify:

- Sticker appears in the notification
- GIF stickers animate
- APNG stickers show (at minimum as static frame, ideally as GIF)

- [ ] **Step 3: Test image attachments**

Send a message with a GIF attachment. Verify:

- Image appears in notification
- GIF animates (not a static first frame)

- [ ] **Step 4: Test embeds**

Send a link that generates an embed with an animated image (e.g., a Tenor GIF link). Verify:

- Embed preview appears with the colored accent bar
- Embedded image animates

- [ ] **Step 5: Test combined content**

Send a message with custom emoji + text + an image attachment. Verify all render correctly together.

- [ ] **Step 6: Final commit if any tweaks were needed**

```bash
git add src/userplugins/richNotify/index.ts
git commit -m "fix: finalize RichNotify media rendering fixes"
```
