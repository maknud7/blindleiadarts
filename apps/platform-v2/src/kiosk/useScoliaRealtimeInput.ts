import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api";

type RealtimeConfig = {
  enabled?: boolean;
  websocket_url?: string | null;
};

export type ScoliaRealtimeMessage = {
  bridge_sequence?: string | number | null;
  spooled_at?: string | null;
  environment?: string | null;
  message?: {
    id?: string;
    type?: string;
    payload?: Record<string, unknown>;
    bridgeSequence?: string | number;
    [key: string]: unknown;
  };
};

export function useScoliaRealtimeInput({
  enabled,
  kioskCode,
  onInput,
}: {
  enabled: boolean;
  kioskCode: string;
  onInput: (input: ScoliaRealtimeMessage) => void;
}) {
  const callbackRef = useRef(onInput);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    callbackRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setConnected(false);

    if (!enabled || !kioskCode) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    let stopped = false;

    const connect = async () => {
      if (stopped || generation !== generationRef.current) return;
      let config: RealtimeConfig;
      try {
        config = await api<RealtimeConfig>("/realtime/config");
      } catch {
        scheduleRetry();
        return;
      }
      if (!config.enabled || !config.websocket_url) return;

      try {
        const socket = new WebSocket(config.websocket_url);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (stopped || generation !== generationRef.current) {
            socket.close();
            return;
          }
          setConnected(true);
          socket.send(JSON.stringify({ type: "subscribe", channels: [`kiosk:${kioskCode}`] }));
        });

        socket.addEventListener("message", (event) => {
          try {
            const envelope = JSON.parse(String(event.data || ""));
            if (envelope?.type !== "event" || envelope?.event !== "scolia_input") return;
            callbackRef.current(envelope.payload as ScoliaRealtimeMessage);
          } catch {
            // Malformed realtime messages are ignored; canonical polling remains fallback.
          }
        });

        socket.addEventListener("close", () => {
          if (socketRef.current === socket) socketRef.current = null;
          setConnected(false);
          scheduleRetry();
        });

        socket.addEventListener("error", () => socket.close());
      } catch {
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (stopped || generation !== generationRef.current || retryRef.current !== null) return;
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        void connect();
      }, 1_000);
    };

    void connect();

    return () => {
      stopped = true;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      retryRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, kioskCode]);

  return { connected };
}
