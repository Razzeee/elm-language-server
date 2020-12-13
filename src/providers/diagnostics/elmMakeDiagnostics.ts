/* eslint-disable @typescript-eslint/no-unsafe-call */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { container } from "tsyringe";
import util from "util";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Connection,
  TextEdit,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { ITreeContainer } from "../../forest";
import * as utils from "../../util/elmUtils";
import { execCmd } from "../../util/elmUtils";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { Settings } from "../../util/settings";
import { TreeUtils } from "../../util/treeUtils";
import { Utils } from "../../util/utils";
import { IDiagnostic, IElmIssue } from "./diagnosticsProvider";
import { ElmDiagnosticsHelper } from "./elmDiagnosticsHelper";
import execa = require("execa");
import { IElmWorkspace } from "../../elmWorkspace";
import { UriString } from "../../uri";

const ELM_MAKE = "Elm";
export const NAMING_ERROR = "NAMING ERROR";
const RANDOM_ID = randomBytes(16).toString("hex");
export const CODE_ACTION_ELM_MAKE = `elmLS.elmMakeFixer-${RANDOM_ID}`;
const readFile = util.promisify(fs.readFile);

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

type NonEmptyArray<T> = [T, ...T[]];

function elmToolingEntrypointsDecoder(json: unknown): NonEmptyArray<string> {
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    if ("entrypoints" in json) {
      const { entrypoints } = json as { [key: string]: unknown };
      if (Array.isArray(entrypoints) && entrypoints.length > 0) {
        const result: Array<string> = [];
        for (const [index, item] of entrypoints.entries()) {
          if (typeof item === "string" && item.startsWith("./")) {
            result.push(item);
          } else {
            throw new Error(
              `Expected "entrypoints" to contain string paths starting with "./" but got: ${JSON.stringify(
                item,
              )} at index ${index}`,
            );
          }
        }
        return [result[0], ...result.slice(1)];
      } else {
        throw new Error(
          `Expected "entrypoints" to be a non-empty array but got: ${JSON.stringify(
            json,
          )}`,
        );
      }
    } else {
      throw new Error(`There is no "entrypoints" field.`);
    }
  } else {
    throw new Error(`Expected a JSON object but got: ${JSON.stringify(json)}`);
  }
}

export class ElmMakeDiagnostics {
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private settings: Settings;
  private connection: Connection;

  constructor() {
    this.settings = container.resolve("Settings");
    this.connection = container.resolve<Connection>("Connection");
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
  }

  public createDiagnostics = async (
    filePath: URI,
  ): Promise<Map<UriString, IDiagnostic[]>> => {
    const workspaceRootPath = this.elmWorkspaceMatcher
      .getProgramFor(filePath)
      .getRootPath();
    return await this.checkForErrors(
      workspaceRootPath.fsPath,
      filePath.fsPath,
    ).then((issues) => {
      return issues.length === 0
        ? new Map([[filePath.toString(), []]])
        : ElmDiagnosticsHelper.issuesToDiagnosticMap(issues, workspaceRootPath);
    });
  };

  public onCodeAction(params: CodeActionParams): CodeAction[] {
    const { uri } = params.textDocument;
    const elmMakeDiagnostics: IDiagnostic[] = this.filterElmMakeDiagnostics(
      params.context.diagnostics as IDiagnostic[],
    );

    return this.convertDiagnosticsToCodeActions(
      elmMakeDiagnostics,
      URI.file(uri),
    );
  }

  private convertDiagnosticsToCodeActions(
    diagnostics: IDiagnostic[],
    uri: URI,
  ): CodeAction[] {
    const result: CodeAction[] = [];

    const elmWorkspace = this.elmWorkspaceMatcher.getProgramFor(uri);
    const forest = elmWorkspace.getForest();

    const sourceTree = forest.getByUri(uri);

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
      } else if (diagnostic.message.startsWith("UNFINISHED CASE")) {
        // Offer the case completion only if we're at the `of`
        const regex = /^\d+\|\s*.* of\s+\s+#\^#/gm;

        const matches = regex.exec(diagnostic.message);
        if (matches !== null) {
          result.push(
            ...this.addCaseQuickfixes(
              sourceTree,
              diagnostic,
              uri,
              elmWorkspace,
            ),
          );
        }
      } else if (
        diagnostic.message.startsWith("MISSING PATTERNS - This `case`")
      ) {
        result.push(
          ...this.addCaseQuickfixes(sourceTree, diagnostic, uri, elmWorkspace),
        );
      }
    });
    return result;
  }

  private addCaseQuickfixes(
    sourceTree: ITreeContainer | undefined,
    diagnostic: IDiagnostic,
    uri: URI,
    elmWorkspace: IElmWorkspace,
  ): CodeAction[] {
    const result = [];
    const valueNode = sourceTree?.tree.rootNode.namedDescendantForPosition(
      {
        column: diagnostic.range.start.character,
        row: diagnostic.range.start.line,
      },
      {
        column: diagnostic.range.end.character,
        row: diagnostic.range.end.line,
      },
    );

    if (valueNode) {
      if (
        valueNode.firstNamedChild?.type === "case" &&
        valueNode.namedChildren.length > 1 &&
        valueNode.namedChildren[1].type === "value_expr"
      ) {
        const indent = "    ".repeat(
          (valueNode.firstNamedChild?.startPosition.column % 4) + 1,
        );

        const typeDeclarationNode = TreeUtils.getTypeAliasOfCase(
          valueNode.namedChildren[1].firstNamedChild!.firstNamedChild!,
          sourceTree!,
          elmWorkspace,
        );

        if (typeDeclarationNode) {
          const fields = TreeUtils.findAllNamedChildrenOfType(
            "union_variant",
            typeDeclarationNode.node,
          );

          const alreadyAvailableBranches = TreeUtils.findAllNamedChildrenOfType(
            "case_of_branch",
            valueNode,
          )
            ?.map(
              (a) => a.firstNamedChild?.firstNamedChild?.firstNamedChild?.text,
            )
            .filter(Utils.notUndefined.bind(this));

          let edit = "";
          fields?.forEach((unionVariant) => {
            if (
              !alreadyAvailableBranches?.includes(
                unionVariant.firstNamedChild!.text,
              )
            ) {
              const parameters = TreeUtils.findAllNamedChildrenOfType(
                "type_ref",
                unionVariant,
              );

              const caseBranch = `${[
                unionVariant.firstNamedChild!.text,
                parameters
                  ?.map((a) =>
                    a.firstNamedChild?.lastNamedChild?.text.toLowerCase(),
                  )
                  .join(" "),
              ].join(" ")}`;

              edit += `\n${indent}    ${caseBranch} ->\n${indent}        \n`;
            }
          });

          result.push(
            this.createCaseQuickFix(
              uri,
              edit,
              diagnostic,
              `Add missing case branches`,
            ),
          );
        }
      }

      result.push(
        this.createCaseQuickFix(
          uri,
          "\n\n        _ ->\n    ",
          diagnostic,
          `Add \`_\` branch`,
        ),
      );
    }
    return result;
  }

  private createCaseQuickFix(
    uri: URI,
    replaceWith: string,
    diagnostic: IDiagnostic,
    title: string,
  ): CodeAction {
    const map: {
      [uri: string]: TextEdit[];
    } = {};
    if (!map[uri.toString()]) {
      map[uri.toString()] = [];
    }
    map[uri.toString()].push(
      TextEdit.insert(diagnostic.range.end, replaceWith),
    );
    return {
      diagnostics: [diagnostic],
      edit: { changes: map },
      kind: CodeActionKind.QuickFix,
      title,
    };
  }

  private createQuickFix(
    uri: URI,
    replaceWith: string,
    diagnostic: IDiagnostic,
    title: string,
  ): CodeAction {
    const map: {
      [uri: string]: TextEdit[];
    } = {};
    if (!map[uri.toString()]) {
      map[uri.toString()] = [];
    }
    map[uri.toString()].push(TextEdit.replace(diagnostic.range, replaceWith));
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
    filePath: string,
  ): Promise<IElmIssue[]> {
    const settings = await this.settings.getClientSettings();

    const elmToolingPath = path.join(workspaceRootPath, "elm-tooling.json");
    const defaultRelativePathToFile = path.relative(
      workspaceRootPath,
      filePath,
    );
    const [relativePathsToFiles, message]: [
      NonEmptyArray<string>,
      string,
    ] = await readFile(elmToolingPath, {
      encoding: "utf-8",
    })
      .then(JSON.parse)
      .then(elmToolingEntrypointsDecoder)
      .then(
        (entrypoints) => [
          entrypoints,
          `Using entrypoints from ${elmToolingPath}: ${JSON.stringify(
            entrypoints,
          )}`,
        ],
        (error: Error & { code?: string }) => {
          const innerMessage =
            error.code === "ENOENT"
              ? `No elm-tooling.json found in ${workspaceRootPath}.`
              : error.code === "EISDIR"
              ? `Skipping ${elmToolingPath} because it is a directory, not a file.`
              : error instanceof SyntaxError
              ? `Skipping ${elmToolingPath} because it contains invalid JSON: ${error.message}.`
              : `Skipping ${elmToolingPath} because: ${error.message}.`;
          const fullMessage = `Using default entrypoint: ${defaultRelativePathToFile}. ${innerMessage}`;
          return [[defaultRelativePathToFile], fullMessage];
        },
      );
    this.connection.console.info(
      `Find entrypoints: ${message}. See https://github.com/elm-tooling/elm-language-server#configuration for more information.`,
    );

    return new Promise(async (resolve) => {
      const argsMake = [
        "make",
        ...relativePathsToFiles,
        "--report",
        "json",
        "--output",
        "/dev/null",
      ];

      const argsTest = [
        "make",
        ...relativePathsToFiles,
        "--report",
        "json",
        "--output",
        "/dev/null",
      ];

      const makeCommand: string = settings.elmPath;
      const testCommand: string = settings.elmTestPath;
      const isTestFile = utils.isTestFile(filePath, workspaceRootPath);
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
        await execCmd(
          testOrMakeCommand,
          testOrMakeCommandWithOmittedSettings,
          options,
          workspaceRootPath,
          this.connection,
        );
        resolve([]);
      } catch (error) {
        if (typeof error === "string") {
          resolve([]);
        } else {
          const execaError = error as execa.ExecaReturnValue<string>;
          const lines: IElmIssue[] = [];
          execaError.stderr.split("\n").forEach((line: string) => {
            let errorObject: any;
            try {
              errorObject = JSON.parse(line);
            } catch (error) {
              this.connection.console.warn(
                "Received an invalid json, skipping error.",
              );
            }

            if (errorObject && errorObject.type === "compile-errors") {
              errorObject.errors.forEach((error: IError) => {
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
            } else if (errorObject && errorObject.type === "error") {
              const problem: IElmIssue = {
                details: errorObject.message
                  .map((message: string | IStyledString) =>
                    typeof message === "string" ? message : message.string,
                  )
                  .join(""),
                // elm-test might supply absolute paths to files
                file: errorObject.path
                  ? path.relative(workspaceRootPath, errorObject.path)
                  : relativePathsToFiles[0],
                overview: errorObject.title,
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
          resolve(lines);
        }
      }
    });
  }
}
