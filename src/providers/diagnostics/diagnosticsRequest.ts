import {
  CancellationToken,
  CancellationTokenSource,
} from "vscode-languageserver";

export class DiagnosticsRequest {
  public static execute(
    requestor: (
      files: string[],
      delay: number,
      cancellationToken: CancellationToken,
    ) => Promise<void>,
    files: string[],
    onDone: () => void,
  ): DiagnosticsRequest {
    return new DiagnosticsRequest(requestor, files, onDone);
  }

  private done = false;
  private readonly token: CancellationTokenSource =
    new CancellationTokenSource();

  private constructor(
    requestor: (
      files: string[],
      delay: number,
      cancellationToken: CancellationToken,
    ) => Promise<void>,
    public readonly files: string[],
    onDone: () => void,
  ) {
    if (!files.length) {
      this.done = true;
      onDone();
    } else {
      requestor(files, 0, this.token.token).finally(() => {
        if (this.done) {
          return;
        }
        this.done = true;
        onDone();
      });
    }
  }

  public cancel(): void {
    if (!this.done) {
      this.token.cancel();
    }

    this.token.dispose();
  }
}
