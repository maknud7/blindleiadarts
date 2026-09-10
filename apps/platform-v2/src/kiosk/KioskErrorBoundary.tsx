import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class KioskErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Kiosk v2 render failure", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return <main className="kiosk-fatal" role="alert">
      <span className="pill bad">Terminalfeil</span>
      <h1>Kiosken kunne ikke vises</h1>
      <p>{this.state.error.message || "En uventet visningsfeil oppstod."}</p>
      <button className="button" type="button" onClick={() => window.location.reload()}>Last inn på nytt</button>
    </main>;
  }
}
