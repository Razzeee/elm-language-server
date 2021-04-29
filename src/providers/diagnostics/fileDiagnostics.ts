import { Utils } from "../../util/utils";
import { IDiagnostic } from "./diagnosticsProvider";

export const enum DiagnosticKind {
  ElmMake,
  ElmTest,
  ElmLS,
  Syntactic,
  Semantic,
  Suggestion,
  ElmReview,
}

export function diagnosticsEquals(a: IDiagnostic, b: IDiagnostic): boolean {
  if (a === b) {
    return true;
  }

  return (
    a.message === b.message &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.data.code === b.data.code &&
    a.data.uri === b.data.uri &&
    Utils.rangeEquals(a.range, b.range) &&
    Utils.arrayEquals(
      a.relatedInformation ?? [],
      b.relatedInformation ?? [],
      (a, b) => {
        return (
          a.message === b.message &&
          Utils.rangeEquals(a.location.range, b.location.range) &&
          a.location.uri === b.location.uri
        );
      },
    ) &&
    Utils.arrayEquals(a.tags ?? [], b.tags ?? [])
  );
}

export class FileDiagnostics {
  private diagnostics: Map<DiagnosticKind, IDiagnostic[]> = new Map<
    DiagnosticKind,
    IDiagnostic[]
  >();

  constructor(public uri: string) {}

  public get(): IDiagnostic[] {
    return [
      ...this.getForKind(DiagnosticKind.ElmMake),
      ...this.getForKind(DiagnosticKind.ElmTest),
      ...this.getForKind(DiagnosticKind.ElmReview),
      ...this.getForKind(DiagnosticKind.ElmLS),
      ...this.getForKind(DiagnosticKind.Syntactic),
      ...this.getForKind(DiagnosticKind.Semantic),
      ...this.getForKind(DiagnosticKind.Suggestion),
    ];
  }

  public update(kind: DiagnosticKind, diagnostics: IDiagnostic[]): boolean {
    const existing = this.getForKind(kind);
    if (Utils.arrayEquals(existing, diagnostics, diagnosticsEquals)) {
      return false;
    }

    this.diagnostics.set(kind, diagnostics);
    return true;
  }

  public getForKind(kind: DiagnosticKind): IDiagnostic[] {
    return this.diagnostics.get(kind) ?? [];
  }
}
