import { container, injectable } from "tsyringe";
import {
  CancellationToken,
  Connection,
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
  FileChangeType,
  DidChangeTextDocumentParams,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { ServerCancellationToken } from "../../cancellation";
import { IProgram } from "../../compiler/program";
import { GetDiagnosticsRequest } from "../../protocol";
import { Delayer } from "../../util/delayer";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { MultistepOperation } from "../../util/multistepOperation";
import { IClientSettings } from "../../util/settings";
import { TextDocumentEvents } from "../../util/textDocumentEvents";
import { Diagnostic } from "../../compiler/diagnostics";
import { ASTProvider } from "../astProvider";
import { DiagnosticSource } from "./diagnosticSource";
import { DiagnosticsRequest } from "./diagnosticsRequest";
import { ElmLsDiagnostics } from "./elmLsDiagnostics";
import { ElmMakeDiagnostics } from "./elmMakeDiagnostics";
import { DiagnosticKind, FileDiagnostics } from "./fileDiagnostics";
import { ISourceFile } from "../../compiler/forest";
import { ElmReviewDiagnostics } from "./elmReviewDiagnostics";
import { Url } from "url";

export interface IElmIssueRegion {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface IElmIssue {
  tag: string;
  overview: string;
  subregion: string;
  details: string;
  region: IElmIssueRegion;
  type: string;
  file: string;
}

export interface IDiagnostic extends Omit<LspDiagnostic, "code"> {
  source: DiagnosticSource;
  data: {
    uri: string;
    code: string;
  };
}

export function convertFromCompilerDiagnostic(diag: Diagnostic): IDiagnostic {
  return {
    message: diag.message,
    source: diag.source,
    severity: diag.severity,
    range: diag.range,
    data: {
      uri: diag.uri,
      code: diag.code,
    },
    tags: diag.tags,
  };
}

export function convertToCompilerDiagnostic(diag: IDiagnostic): Diagnostic {
  return {
    message: diag.message,
    source: diag.source,
    severity: diag.severity ?? DiagnosticSeverity.Warning,
    range: diag.range,
    code: diag.data.code,
    uri: diag.data.uri,
    tags: diag.tags,
  };
}

class PendingDiagnostics extends Map<string, number> {
  public getOrderedFiles(): string[] {
    return Array.from(this.entries())
      .sort((a, b) => a[1] - b[1])
      .map((a) => a[0]);
  }
}

@injectable()
export class DiagnosticsProvider {
  private elmMakeDiagnostics: ElmMakeDiagnostics;
  private elmReviewDiagnostics: ElmReviewDiagnostics;
  private elmLsDiagnostics: ElmLsDiagnostics;
  private currentDiagnostics: Map<string, FileDiagnostics>;
  private events: TextDocumentEvents;
  private connection: Connection;
  private clientSettings: IClientSettings;
  private workspaces: IProgram[];
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private documentEvents: TextDocumentEvents;

  private pendingRequest: DiagnosticsRequest | undefined;
  private pendingDiagnostics: PendingDiagnostics;
  private diagnosticsDelayer: Delayer<any>;
  private diagnosticsOperation: MultistepOperation;
  private changeSeq = 0;

  constructor() {
    this.clientSettings = container.resolve("ClientSettings");

    this.elmMakeDiagnostics = container.resolve(ElmMakeDiagnostics);
    this.elmReviewDiagnostics = container.resolve(ElmReviewDiagnostics);
    this.elmLsDiagnostics = container.resolve(ElmLsDiagnostics);
    this.documentEvents = container.resolve(TextDocumentEvents);

    this.connection = container.resolve("Connection");
    this.events = container.resolve(TextDocumentEvents);
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
    this.diagnosticsOperation = new MultistepOperation(this.connection);

    this.workspaces = container.resolve("ElmWorkspaces");

    const astProvider = container.resolve(ASTProvider);

    this.currentDiagnostics = new Map<string, FileDiagnostics>();
    this.pendingDiagnostics = new PendingDiagnostics();
    this.diagnosticsDelayer = new Delayer(300);

    const clientInitiatedDiagnostics =
      this.clientSettings.extendedCapabilities?.clientInitiatedDiagnostics ??
      false;

    const disableDiagnosticsOnChange =
      this.clientSettings.onlyUpdateDiagnosticsOnSave;

    const handleSaveOrOpen = (d: { document: TextDocument }): void => {
      const program = this.elmWorkspaceMatcher.getProgramFor(
        URI.parse(d.document.uri),
      );
      const sourceFile = program.getSourceFile(d.document.uri);

      if (!sourceFile) {
        return;
      }

      void this.getElmMakeDiagnostics(sourceFile).then((hasElmMakeErrors) => {
        if (hasElmMakeErrors) {
          this.currentDiagnostics.forEach((_, uri) => {
            this.updateDiagnostics(uri, DiagnosticKind.ElmReview, []);
          });
        } else {
          void this.getElmReviewDiagnostics(sourceFile);
        }
      });

      // If we aren't doing them on change, we need to trigger them here
      if (disableDiagnosticsOnChange) {
        this.updateDiagnostics(
          sourceFile.uri,
          DiagnosticKind.ElmLS,
          this.elmLsDiagnostics.createDiagnostics(sourceFile, program),
        );
      }
    };

    this.events.on("open", handleSaveOrOpen);
    this.events.on("save", handleSaveOrOpen);

    this.connection.onDidChangeWatchedFiles((event) => {
      const newDeleteEvents = event.changes
        .filter((a) => a.type === FileChangeType.Deleted)
        .map((a) => a.uri);
      newDeleteEvents.forEach((uri) => {
        this.deleteDiagnostics(uri);
      });
    });

    if (clientInitiatedDiagnostics) {
      this.connection.onRequest(
        GetDiagnosticsRequest,
        (params, cancellationToken) =>
          this.getDiagnostics(params.files, params.delay, cancellationToken),
      );
    }

    this.connection.onDidChangeConfiguration((params) => {
      this.clientSettings = <IClientSettings>params.settings;

      if (this.clientSettings.disableElmLSDiagnostics) {
        this.currentDiagnostics.forEach((_, uri) =>
          this.updateDiagnostics(uri, DiagnosticKind.ElmLS, []),
        );
      } else {
        this.workspaces.forEach((program) => {
          if (!program.getForest(false)) {
            return;
          }

          program.getForest().treeMap.forEach((sourceFile) => {
            if (sourceFile.writeable) {
              this.updateDiagnostics(
                sourceFile.uri,
                DiagnosticKind.ElmLS,
                this.elmLsDiagnostics.createDiagnostics(sourceFile, program),
              );
            }
          });
        });
      }
    });

    if (!clientInitiatedDiagnostics && !disableDiagnosticsOnChange) {
      this.requestAllDiagnostics();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    astProvider.onTreeChange(({ sourceFile, declaration }) => {
      if (!clientInitiatedDiagnostics && !disableDiagnosticsOnChange) {
        this.requestDiagnostics(sourceFile.uri);
      }
    });

    this.documentEvents.on("change", (params: DidChangeTextDocumentParams) => {
      this.change();

      this.updateDiagnostics(
        params.textDocument.uri,
        DiagnosticKind.ElmReview,
        [],
      );

      // We need to cancel the request as soon as possible
      if (!clientInitiatedDiagnostics && !disableDiagnosticsOnChange) {
        if (this.pendingRequest) {
          this.pendingRequest.cancel();
          this.pendingRequest = undefined;
        }
      }
    });
  }

  public interruptDiagnostics<T>(f: () => T): T {
    if (!this.pendingRequest) {
      return f();
    }

    this.pendingRequest.cancel();
    this.pendingRequest = undefined;
    const result = f();

    this.triggerDiagnostics();
    return result;
  }

  public getCurrentDiagnostics(
    uri: string,
    kind?: DiagnosticKind,
  ): IDiagnostic[] {
    if (kind) {
      return this.currentDiagnostics.get(uri)?.getForKind(kind) ?? [];
    }

    return this.currentDiagnostics.get(uri)?.get() ?? [];
  }

  /**
   * Used for tests only
   */
  public forceElmLsDiagnosticsUpdate(
    sourceFile: ISourceFile,
    program: IProgram,
  ): void {
    this.updateDiagnostics(
      sourceFile.uri,
      DiagnosticKind.ElmLS,
      this.elmLsDiagnostics.createDiagnostics(sourceFile, program),
    );
  }

  private requestDiagnostics(uri: string): void {
    this.pendingDiagnostics.set(uri, Date.now());
    this.triggerDiagnostics();
  }

  private requestAllDiagnostics(): void {
    this.workspaces.forEach((program) => {
      if (!program.getForest(false)) {
        return;
      }

      program.getForest().treeMap.forEach(({ uri, writeable }) => {
        if (writeable) {
          this.pendingDiagnostics.set(uri, Date.now());
        }
      });
    });

    this.triggerDiagnostics();
  }
  private triggerDiagnostics(delay = 200): void {
    const sendPendingDiagnostics = (): void => {
      const orderedFiles = this.pendingDiagnostics.getOrderedFiles();

      if (this.pendingRequest) {
        this.pendingRequest.cancel();

        this.pendingRequest.files.forEach((file) => {
          if (!orderedFiles.includes(file)) {
            orderedFiles.push(file);
          }
        });

        this.pendingRequest = undefined;
      }

      // Add all open files to request
      const openFiles = this.events.getManagedUris();
      openFiles.forEach((file) => {
        if (!orderedFiles.includes(file)) {
          orderedFiles.push(file);
        }
      });

      if (orderedFiles.length) {
        const request = (this.pendingRequest = DiagnosticsRequest.execute(
          this.getDiagnostics.bind(this),
          orderedFiles,
          () => {
            if (request === this.pendingRequest) {
              this.pendingRequest = undefined;
            }
          },
        ));
      }

      this.pendingDiagnostics.clear();
    };

    void this.diagnosticsDelayer.trigger(sendPendingDiagnostics, delay);
  }

  private updateDiagnostics(
    uri: string,
    kind: DiagnosticKind,
    diagnostics: IDiagnostic[],
  ): void {
    let didUpdate = false;

    let fileDiagnostics = this.currentDiagnostics.get(uri);

    if (fileDiagnostics) {
      didUpdate = fileDiagnostics.update(kind, diagnostics);
    } else if (diagnostics.length > 0) {
      fileDiagnostics = new FileDiagnostics(uri);
      fileDiagnostics.update(kind, diagnostics);
      this.currentDiagnostics.set(uri, fileDiagnostics);
      didUpdate = true;
    }

    if (didUpdate) {
      const fileDiagnostics = this.currentDiagnostics.get(uri);
      this.connection.sendDiagnostics({
        uri,
        diagnostics: fileDiagnostics ? fileDiagnostics.get() : [],
      });
    }
  }

  private deleteDiagnostics(uri: string): void {
    this.currentDiagnostics.delete(uri);
    this.connection.sendDiagnostics({
      uri,
      diagnostics: [],
    });
  }

  private getDiagnostics(
    files: string[],
    delay: number,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const followMs = Math.min(delay, 200);
    const serverCancellationToken = new ServerCancellationToken(
      cancellationToken,
    );

    return new Promise((resolve) =>
      this.diagnosticsOperation.startNew(
        cancellationToken,
        (next) => {
          const seq = this.changeSeq;

          let index = 0;
          const goNext = (): void => {
            index++;
            if (files.length > index) {
              next.delay(followMs, checkOne);
            }
          };

          const checkOne = (): void => {
            if (this.changeSeq !== seq) {
              return;
            }

            const uri = files[index];
            const program = this.elmWorkspaceMatcher.getProgramFor(
              URI.parse(uri),
            );

            const sourceFile = program.getForest().getByUri(uri);

            if (!sourceFile) {
              goNext();
              return;
            }

            next.immediate(() => {
              this.updateDiagnostics(uri, DiagnosticKind.ElmMake, []);
              this.updateDiagnostics(
                uri,
                DiagnosticKind.Syntactic,
                program
                  .getSyntacticDiagnostics(sourceFile)
                  .map(convertFromCompilerDiagnostic),
              );

              if (this.changeSeq !== seq) {
                return;
              }

              next.promise(async () => {
                const diagnostics = await program.getSemanticDiagnosticsAsync(
                  sourceFile,
                  serverCancellationToken,
                );

                if (this.changeSeq !== seq) {
                  return;
                }

                this.updateDiagnostics(
                  uri,
                  DiagnosticKind.Semantic,
                  diagnostics.map(convertFromCompilerDiagnostic),
                );

                next.immediate(() => {
                  this.updateDiagnostics(
                    uri,
                    DiagnosticKind.Suggestion,
                    program
                      .getSuggestionDiagnostics(
                        sourceFile,
                        serverCancellationToken,
                      )
                      .map(convertFromCompilerDiagnostic),
                  );

                  if (this.changeSeq !== seq) {
                    return;
                  }

                  if (!this.clientSettings.disableElmLSDiagnostics) {
                    next.immediate(() => {
                      this.updateDiagnostics(
                        uri,
                        DiagnosticKind.ElmLS,
                        this.elmLsDiagnostics.createDiagnostics(
                          sourceFile,
                          program,
                        ),
                      );

                      goNext();
                    });
                  } else {
                    goNext();
                  }
                });
              });
            });
          };

          if (files.length > 0 && this.changeSeq === seq) {
            next.delay(delay, checkOne);
          }
        },
        resolve,
      ),
    );
  }

  private async getElmMakeDiagnostics(
    sourceFile: ISourceFile,
  ): Promise<boolean> {
    const elmMakeDiagnostics = await this.elmMakeDiagnostics.createDiagnostics(
      sourceFile,
    );

    this.resetDiagnostics(elmMakeDiagnostics, DiagnosticKind.ElmMake);

    elmMakeDiagnostics.forEach((diagnostics, diagnosticsUri) => {
      this.updateDiagnostics(diagnosticsUri, DiagnosticKind.Syntactic, []);
      this.updateDiagnostics(diagnosticsUri, DiagnosticKind.Semantic, []);
      this.updateDiagnostics(
        diagnosticsUri,
        DiagnosticKind.ElmMake,
        diagnostics,
      );
    });

    this.currentDiagnostics.forEach((_, uri) => {
      if (!elmMakeDiagnostics.has(uri)) {
        this.updateDiagnostics(uri, DiagnosticKind.ElmMake, []);
      }
    });

    // return true if elm make returned non empty results,
    // it returns `new Map([[sourceFile.uri, []]])` in case of no errors
    return !(
      elmMakeDiagnostics.size === 1 &&
      elmMakeDiagnostics.get(sourceFile.uri)?.length === 0
    );
  }

  private async getElmReviewDiagnostics(
    sourceFile: ISourceFile,
  ): Promise<void> {
    const elmReviewDiagnostics =
      await this.elmReviewDiagnostics.createDiagnostics(sourceFile);

    // remove old elm-review diagnostics
    this.resetDiagnostics(elmReviewDiagnostics, DiagnosticKind.ElmReview);

    // add new elm-review diagnostics
    elmReviewDiagnostics.forEach((diagnostics, uri) => {
      this.updateDiagnostics(uri, DiagnosticKind.ElmReview, diagnostics);
    });
  }

  private resetDiagnostics(
    diagnosticList: Map<string, IDiagnostic[]>,
    diagnosticKind: DiagnosticKind,
  ): void {
    this.currentDiagnostics.forEach((fileDiagnostics, diagnosticsUri) => {
      if (
        !diagnosticList.has(diagnosticsUri) &&
        fileDiagnostics.getForKind(diagnosticKind).length > 0
      ) {
        diagnosticList.set(diagnosticsUri, []);
      }
    });
  }

  private change(): void {
    this.changeSeq++;
  }
}
