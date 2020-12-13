import { container, injectable } from "tsyringe";
import {
  DocumentFormattingParams,
  Connection,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { DiagnosticsProvider } from ".";
import * as Diff from "../util/diff";
import { execCmd } from "../util/elmUtils";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { Settings } from "../util/settings";
import { TextDocumentEvents } from "../util/textDocumentEvents";
import { IDocumentFormattingParams } from "./paramsExtensions";

type DocumentFormattingResult = Promise<TextEdit[] | undefined>;

@injectable()
export class DocumentFormattingProvider {
  private events: TextDocumentEvents;
  private connection: Connection;
  private settings: Settings;
  private diagnostics: DiagnosticsProvider;

  constructor() {
    this.settings = container.resolve<Settings>("Settings");
    this.connection = container.resolve<Connection>("Connection");
    this.events = container.resolve<TextDocumentEvents>(TextDocumentEvents);
    this.diagnostics = container.resolve(DiagnosticsProvider);
    this.connection.onDocumentFormatting(
      this.diagnostics.interruptDiagnostics(() =>
        new ElmWorkspaceMatcher((params: DocumentFormattingParams) =>
          URI.parse(params.textDocument.uri),
        ).handle(this.handleFormattingRequest),
      ),
    );
  }

  public formatText = async (
    elmWorkspaceRootPath: URI,
    elmFormatPath: string,
    text: string,
  ): DocumentFormattingResult => {
    const options = {
      cmdArguments: ["--stdin", "--elm-version", "0.19", "--yes"],
      notFoundText: "Install elm-format via 'npm install -g elm-format",
    };

    try {
      const format = await execCmd(
        elmFormatPath,
        "elm-format",
        options,
        elmWorkspaceRootPath.fsPath,
        this.connection,
        text,
      );
      return Diff.getTextRangeChanges(text, format.stdout);
    } catch (error) {
      this.connection.console.warn(JSON.stringify(error));
    }
  };

  protected handleFormattingRequest = async (
    params: IDocumentFormattingParams,
  ): DocumentFormattingResult => {
    this.connection.console.info(`Formatting was requested`);
    try {
      const text = this.events.get(URI.parse(params.textDocument.uri));
      if (!text) {
        this.connection.console.error("Can't find file for formatting.");
        return;
      }

      const settings = await this.settings.getClientSettings();
      return await this.formatText(
        params.program.getRootPath(),
        settings.elmFormatPath,
        text.getText(),
      );
    } catch (error) {
      (error.message as string).includes("SYNTAX PROBLEM")
        ? this.connection.console.error(
            "Running elm-format failed. Check the file for syntax errors.",
          )
        : this.connection.window.showErrorMessage(
            "Running elm-format failed. Install via " +
              "'npm install -g elm-format' and make sure it's on your path",
          );
    }
  };
}
