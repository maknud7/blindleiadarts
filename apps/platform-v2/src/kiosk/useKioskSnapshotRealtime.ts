import { useEffect, useRef } from "react";
import { api } from "../shared/api";

type RealtimeConfig = { enabled?: boolean; websocket_url?: string | null };

type Options = {
  enabled: boolean;
  kioskCode: string;
  clubId?: string | number | null;
  onRefresh: () => void;
};

/**
 * Wake the canonical kiosk state reader as soon as another consumer commits a
 * match mutation. An existing 1.5s canonical polling loop remains the safety
 * net when the socket, subscription or relay is unavailable.
 *
 * This is independent of Scolia and works for manually scored matches.
 */
export function useKioskSnapshotRealtime({ enabled, kioskCode, clubId, onRefresh }: Options): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || !kioskCode || typeof WebSocket !== "function") return;

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let lastRefreshAt = 0;

    const connect = async () => {
      if (stopped) return;
      try {
        const config = await api<RealtimeConfig>("/realtime/config");
        if (stopped || !config.enabled || !config.websocket_url) return;

        const nextSocket = new WebSocket(config.websocket_url);
        socket = nextSocket;
        nextSocket.addEventListener("open", () => {
          if (stopped) return;
          const channels = [`kiosk:${kioskCode}`];
          if (clubId != null && String(clubId).trim() !== "") {
            channels.push(`club:${String(clubId)}`);
          }
          nextSocket.send(JSON.stringify({ type: "subscribe", channels }));
        });
        nextSocket.addEventListener("message", (event) => {
          if (stopped) return;
          try {
            const message = JSON.parse(String(event.data));
            if (message?.type !== "event" || message.event !== "snapshot") return;
            const now = Date.now();
            if (now - lastRefreshAt < 150) return; // Coalesce kiosk + club broadcasts.
            lastRefreshAt = now;
            refreshRef.current();
          } catch {
            // Invalid relay traffic must not interrupt the canonical polling path.
          }
        });
        nextSocket.addEventListener("close", () => {
          if (socket === nextSocket) socket = null;
          if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 2500);
        });
        nextSocket.addEventListener("error", () => nextSocket.close());
      } catch {
        // Transient configuration/network failure: keep polling and try later.
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 5000);
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, kioskCode, clubId]);
}
