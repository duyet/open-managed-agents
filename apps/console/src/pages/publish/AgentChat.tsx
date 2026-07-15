import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

interface StreamEvent {
  type: string;
  content?: Array<{ type: string; text?: string }>;
  delta?: string;
  message_id?: string;
  error?: string;
}

export function AgentChat() {
  const { agent_id } = useParams();
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const send = async () => {
    const text = input.trim();
    if (!text || !agent_id) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setStreamText("");

    try {
      let sid = sessionId;

      if (!sid) {
        const res = await fetch("/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: agent_id }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          setError(err.error || "Failed to create session");
          return;
        }
        const session = await res.json();
        sid = session.id;
        setSessionId(sid);
      }

      setSending(true);

      const eventRes = await fetch(`/v1/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });

      if (!eventRes.ok) {
        const err = await eventRes.json().catch(() => ({ error: eventRes.statusText }));
        setError(err.error || "Failed to send message");
        setSending(false);
        return;
      }

      const reader = eventRes.body?.getReader();
      if (!reader) {
        setSending(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullReply = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const event = JSON.parse(data) as StreamEvent;
            if (event.type === "agent.message_chunk" && event.delta) {
              fullReply += event.delta;
              setStreamText(fullReply);
            } else if (event.type === "agent.message" && event.content) {
              const mtext = event.content.map((c) => c.text || "").join("");
              fullReply = mtext;
              setStreamText(mtext);
            } else if (event.type === "session.error") {
              setError(event.error || "Session error");
            }
          } catch {
            // skip malformed JSON
          }
        }
      }

      setMessages((m) => [...m, { role: "assistant", text: fullReply }]);
      setStreamText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="border-b border-gray-200 px-4 py-3 bg-white shrink-0">
        <h1 className="text-sm font-semibold text-gray-900">Agent Chat</h1>
        <p className="text-xs text-gray-500">Session: {sessionId ? sessionId.slice(0, 12) + "…" : "not started"}</p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !error && (
          <p className="text-sm text-gray-400 text-center mt-12">
            Send a message to start chatting with this agent.
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {streamText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-900">
              {streamText}
              <span className="inline-block w-1.5 h-4 bg-gray-400 ml-0.5 animate-pulse" />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-200 px-4 py-3 bg-white shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type a message…"
            disabled={sending}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
