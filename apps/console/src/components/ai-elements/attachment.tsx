"use client";

import { FileTextIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Loose shape of an Anthropic-style content block as it arrives over the
 * OMA event wire (see ContentBlock in apps/agent/src/harness/default-loop.ts
 * normalizeToolOutputForWire). Only the fields Attachment cares about are
 * typed; everything else is ignored defensively since tool outputs are
 * agent/tool-authored and not schema-guaranteed at the console layer.
 */
export interface ContentBlockLike {
  type: string;
  text?: string;
  source?: {
    type?: string;
    data?: string;
    url?: string;
    media_type?: string;
  };
}

export function isContentBlockArray(value: unknown): value is ContentBlockLike[] {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((b) => b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string")
  );
}

function blockSrc(block: ContentBlockLike): string | undefined {
  const source = block.source;
  if (!source) return undefined;
  if (source.type === "url" && source.url) return source.url;
  if (source.data) return `data:${source.media_type || "application/octet-stream"};base64,${source.data}`;
  if (source.url) return source.url;
  return undefined;
}

/** Rough on-wire size from a base64 payload — base64 inflates bytes by ~4/3. */
function formatBytes(base64: string | undefined): string | undefined {
  if (!base64) return undefined;
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Renders a single Anthropic-shape content block that isn't plain text —
 * an `image` (base64 or url source) or a `document` (PDF etc). Used both
 * for user.message attachments (files the user sent) and for tool outputs
 * that returned media (e.g. `read` on a PNG, a computer-use screenshot).
 *
 * Images render as a clickable thumbnail that opens the full-size image
 * in a new tab — no modal state needed. Documents render as a small
 * metadata card since there's no cheap way to preview arbitrary file
 * types inline.
 */
export function Attachment({ block, className }: { block: ContentBlockLike; className?: string }) {
  if (!block || typeof block !== "object") return null;

  if (block.type === "image") {
    const src = blockSrc(block);
    if (!src) return null;
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "block max-h-64 w-fit overflow-hidden rounded-lg border border-border/50 transition-opacity hover:opacity-90",
          className,
        )}
      >
        <img src={src} alt="Attached image" className="max-h-64 w-auto object-contain" />
      </a>
    );
  }

  if (block.type === "document") {
    const mediaType = block.source?.media_type ?? "application/octet-stream";
    const size = formatBytes(block.source?.data);
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border/50 bg-bg-surface/40 px-3 py-2 text-xs",
          className,
        )}
      >
        <FileTextIcon className="size-4 text-fg-subtle shrink-0" />
        <div className="min-w-0">
          <div className="truncate font-medium text-fg">{mediaType}</div>
          {size && <div className="text-fg-subtle">{size}</div>}
        </div>
      </div>
    );
  }

  return null;
}
