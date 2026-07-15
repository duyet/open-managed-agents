import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

export function AgentChat() {
  const { agent_id } = useParams<{ agent_id: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !agent_id || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);
    setStreamingText("");

    try {
      let sid = sessionId;
      if (!sid) {
        const res = await fetch("/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent_id }),
        });
        if (!res.ok) throw new Error("Failed to create session");
        const session = await res.json();
        sid = session.id;
        setSessionId(sid);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`/v1/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Request failed");
      }

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data) as { type?: string; delta?: string; content?: Array<{ text?: string }> };
                if (parsed.type === "agent.message_chunk" && parsed.delta) {
                  setStreamingText((prev) => prev + parsed.delta);
                } else if (parsed.type === "agent.message" && parsed.content) {
                  const fullText = parsed.content.map((c) => c.text || "").join("");
                  setMessages((prev) => [...prev, { role: "agent", text: fullText }]);
                  setStreamingText("");
                }
              } catch {
                // skip unparseable lines
              }
            }
          }
        }
      }

      setStreamingText("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => [...prev, { role: "agent", text: `Error: ${(err as Error).message}` }]);
      }
    }
    setLoading(false);
    abortRef.current = null;
  };

  return (
    <div className="flex flex-col h-screen bg-bg">
      <header className="border-b border-border px-4 py-3">
        <h1 className="font-display text-lg font-semibold text-fg">Chat</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !loading && (
          <p className="text-sm text-fg-muted text-center mt-8">
            Send a message to start chatting with this agent.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-brand text-brand-fg"
                  : "bg-bg-surface text-fg border border-border"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-4 py-2 text-sm bg-bg-surface text-fg border border-border">
              {streamingText}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="flex gap-2 max-w-2xl mx-auto">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Type a message…"
            disabled={loading}
            className="flex-1 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-4 py-2 bg-brand text-brand-fg text-sm font-medium rounded-md hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
