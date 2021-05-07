/* eslint-disable @typescript-eslint/no-unsafe-call */
import { randomBytes } from "crypto";
import * as path from "path";
import { container } from "tsyringe";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Connection,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { ISourceFile } from "../../compiler/forest";
import * as utils from "../../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { Settings } from "../../util/settings";
import { NonEmptyArray } from "../../util/utils";
import { IDiagnostic, IElmIssue } from "./diagnosticsProvider";
import { ElmDiagnosticsHelper } from "./elmDiagnosticsHelper";
import execa = require("execa");
import { ElmToolingJsonManager } from "../../elmToolingJsonManager";
import { createNodeProgramHost } from "../../compiler/program";

const ELM_MAKE = "Elm";
export const NAMING_ERROR = "NAMING ERROR";
const RANDOM_ID = randomBytes(16).toString("hex");
export const CODE_ACTION_ELM_MAKE = `elmLS.elmMakeFixer-${RANDOM_ID}`;

export interface IElmCompilerError {
  type: string;
  errors: IError[];
}

export interface IElmError {
  title: string;
  type: string;
  path: string;
  message: (string | IStyledString)[];
}

export interface IError {
  path: string | null;
  name: string;
  problems: IProblem[];
}

export interface IProblem {
  title: string;
  region: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  message: (string | IStyledString)[];
}

export interface IStyledString {
  bold: boolean;
  underline: boolean;
  color: string;
  string: string;
}

export class ElmMakeDiagnostics {
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private settings: Settings;
  private elmToolingJsonManager: ElmToolingJsonManager;
  private connection: Connection;

  constructor() {
    this.settings = container.resolve("Settings");
    this.connection = container.resolve<Connection>("Connection");
    this.elmToolingJsonManager = container.resolve<ElmToolingJsonManager>(
      "ElmToolingJsonManager",
    );
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
  }

  public createDiagnostics = async (
    sourceFile: ISourceFile,
  ): Promise<Map<string, IDiagnostic[]>> => {
    const filePath = URI.parse(sourceFile.uri);
    const workspaceRootPath = this.elmWorkspaceMatcher
      .getProgramFor(filePath)
      .getRootPath();
    return await this.checkForErrors(workspaceRootPath.fsPath, sourceFile).then(
      (issues) => {
        return issues.length === 0
          ? new Map([[filePath.toString(), []]])
          : ElmDiagnosticsHelper.issuesToDiagnosticMap(
              issues,
              workspaceRootPath,
            );
      },
    );
  };

  public onCodeAction(params: CodeActionParams): CodeAction[] {
    const { uri } = params.textDocument;
    const elmMakeDiagnostics: IDiagnostic[] = this.filterElmMakeDiagnostics(
      params.context.diagnostics as IDiagnostic[],
    );

    return this.convertDiagnosticsToCodeActions(elmMakeDiagnostics, uri);
  }

  private hasType(error: any): error is IElmError | IElmCompilerError {
    return "type" in error;
  }

  private convertDiagnosticsToCodeActions(
    diagnostics: IDiagnostic[],
    uri: string,
  ): CodeAction[] {
    const result: CodeAction[] = [];

    diagnostics.forEach((diagnostic) => {
      if (
        diagnostic.message.startsWith(NAMING_ERROR) ||
        diagnostic.message.startsWith("BAD IMPORT") ||
        diagnostic.message.startsWith("UNKNOWN LICENSE") ||
        diagnostic.message.startsWith("UNKNOWN PACKAGE") ||
        diagnostic.message.startsWith("UNKNOWN EXPORT")
      ) {
        // Offer the name suggestions from elm make to our users
        const regex = /^\s{4}#(.*)#$/gm;
        let matches;

        while ((matches = regex.exec(diagnostic.message)) !== null) {
          // This is necessary to avoid infinite loops with zero-width matches
          if (matches.index === regex.lastIndex) {
            regex.lastIndex++;
          }

          matches
            .filter((_, groupIndex) => groupIndex === 1)
            .forEach((match) => {
              result.push(
                this.createQuickFix(
                  uri,
                  match,
                  diagnostic,
                  `Change to \`${match}\``,
                ),
              );
            });
        }
      } else if (
        diagnostic.message.startsWith("MODULE NAME MISMATCH") ||
        diagnostic.message.startsWith("UNEXPECTED SYMBOL")
      ) {
        // Offer the name suggestions from elm make to our users
        const regex = /# -> #(.*)#$/gm;

        const matches = regex.exec(diagnostic.message);
        if (matches !== null) {
          result.push(
            this.createQuickFix(
              uri,
              matches[1],
              diagnostic,
              `Change to \`${matches[1]}\``,
            ),
          );
        }
      }
    });
    return result;
  }

  private createQuickFix(
    uri: string,
    replaceWith: string,
    diagnostic: IDiagnostic,
    title: string,
  ): CodeAction {
    const map: {
      [uri: string]: TextEdit[];
    } = {};
    if (!map[uri]) {
      map[uri] = [];
    }
    map[uri].push(TextEdit.replace(diagnostic.range, replaceWith));
    return {
      diagnostics: [diagnostic],
      edit: { changes: map },
      kind: CodeActionKind.QuickFix,
      title,
    };
  }

  private filterElmMakeDiagnostics(diagnostics: IDiagnostic[]): IDiagnostic[] {
    return diagnostics.filter((diagnostic) => diagnostic.source === ELM_MAKE);
  }

  private async checkForErrors(
    workspaceRootPath: string,
    sourceFile: ISourceFile,
  ): Promise<IElmIssue[]> {
    const settings = await this.settings.getClientSettings();

    const [relativePathsToFiles, message]: [
      NonEmptyArray<string>,
      string,
    ] = await this.elmToolingJsonManager.getEntrypoints(
      workspaceRootPath,
      sourceFile,
    );

    this.connection.console.info(
      `Find entrypoints: ${message}. See https://github.com/elm-tooling/elm-language-server#configuration for more information.`,
    );

    const argsMake = [
      "make",
      ...relativePathsToFiles,
      "--report",
      "json",
      "--output",
      "/dev/null",
    ];

    const argsTest = ["make", ...relativePathsToFiles, "--report", "json"];

    const makeCommand: string = settings.elmPath;
    const testCommand: string = settings.elmTestPath;
    const isTestFile = sourceFile.isTestFile;
    const args = isTestFile ? argsTest : argsMake;
    const testOrMakeCommand = isTestFile ? testCommand : makeCommand;
    const testOrMakeCommandWithOmittedSettings = isTestFile
      ? "elm-test"
      : "elm";
    const options = {
      cmdArguments: args,
      notFoundText: isTestFile
        ? "'elm-test' is not available. Install Elm via 'npm install -g elm-test'."
        : "The 'elm' compiler is not available. Install Elm via 'npm install -g elm'.",
    };

    try {
      // Do nothing on success, but return that there were no errors
      utils.execCmdSync(
        testOrMakeCommand,
        testOrMakeCommandWithOmittedSettings,
        options,
        workspaceRootPath,
        createNodeProgramHost(this.connection),
      );
      return [];
    } catch (error) {
      if (typeof error === "string") {
        return [];
      } else {
        const execaError = error as execa.ExecaReturnValue<string>;
        const lines: IElmIssue[] = [];
        execaError.stderr.split("\n").forEach((line: string) => {
          let errorObject: unknown;
          try {
            errorObject = JSON.parse(line);
          } catch (error) {
            this.connection.console.warn(
              "Received an invalid json, skipping error.",
            );
          }

          if (
            errorObject &&
            this.hasType(errorObject) &&
            errorObject.type === "compile-errors"
          ) {
            const compilerError = errorObject as IElmCompilerError;
            compilerError.errors.forEach((error: IError) => {
              const problems: IElmIssue[] = error.problems.map(
                (problem: IProblem) => ({
                  details: problem.message
                    .map((message: string | IStyledString) =>
                      typeof message === "string"
                        ? message
                        : `#${message.string}#`,
                    )
                    .join(""),
                  file: error.path
                    ? path.isAbsolute(error.path)
                      ? path.relative(workspaceRootPath, error.path)
                      : error.path
                    : relativePathsToFiles[0],
                  overview: problem.title,
                  region: problem.region,
                  subregion: "",
                  tag: "error",
                  type: "error",
                }),
              );

              lines.push(...problems);
            });
          } else if (
            errorObject &&
            this.hasType(errorObject) &&
            errorObject.type === "error"
          ) {
            const error = errorObject as IElmError;
            this.checkIfVersionMismatchesAndCreateMessage(error);

            const problem: IElmIssue = {
              details: error.message
                .map((message: string | IStyledString) =>
                  typeof message === "string" ? message : message.string,
                )
                .join(""),
              // elm-test might supply absolute paths to files
              file: error.path
                ? path.relative(workspaceRootPath, error.path)
                : relativePathsToFiles[0],
              overview: error.title,
              region: {
                end: {
                  column: 1,
                  line: 1,
                },
                start: {
                  column: 1,
                  line: 1,
                },
              },
              subregion: "",
              tag: "error",
              type: "error",
            };

            lines.push(problem);
          }
        });
        return lines;
      }
    }
  }
  private checkIfVersionMismatchesAndCreateMessage(
    errorObject: IElmError,
  ): void {
    if (errorObject.title === "ELM VERSION MISMATCH") {
      this.connection.window.showErrorMessage(
        errorObject.message
          .map((message: string | IStyledString) =>
            typeof message === "string" ? message : message.string,
          )
          .join(""),
      );
    }
  }
}
