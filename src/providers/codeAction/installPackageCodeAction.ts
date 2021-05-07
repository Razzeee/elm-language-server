import { ExecaSyncReturnValue } from "execa";
import { container } from "tsyringe";
import { CodeAction, Connection } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { CommandManager } from "../../commandManager";
import { ElmPackageCache } from "../../compiler/elmPackageCache";
import { execCmdSync } from "../../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { Settings } from "../../util/settings";
import { TreeUtils } from "../../util/treeUtils";
import { Diagnostics } from "../../compiler/diagnostics";
import { CodeActionProvider } from "../codeActionProvider";
import { ICodeActionParams } from "../paramsExtensions";
import { comparePackageRanking } from "../ranking";
import { createNodeProgramHost, IProgramHost } from "../../compiler/program";

const errorCodes = [Diagnostics.ImportMissing.code];
const fixId = "install_package";

CodeActionProvider.registerCodeAction({
  errorCodes,
  fixId,
  getCodeActions: (params: ICodeActionParams): CodeAction[] | undefined => {
    const valueNode = TreeUtils.getNamedDescendantForRange(
      params.sourceFile,
      params.range,
    );

    const packages = ElmPackageCache.getPackagesWithModule(valueNode.text);

    return packages.sort(comparePackageRanking).map((packageName) =>
      CodeActionProvider.getCodeAction(
        params,
        `Install package "${packageName}"`,
        [],
        {
          command: "elm.installPackage",
          title: "Install Package",
          arguments: [params.sourceFile.uri, packageName],
        },
      ),
    );
  },
  getFixAllCodeAction: () => {
    // We can't run multiple commands
    return undefined;
  },
});

CommandManager.register(
  "elm.installPackage",
  async (uri: string, packageName: string) => {
    const settings = container.resolve<Settings>("Settings");
    const connection = container.resolve<Connection>("Connection");
    const host = createNodeProgramHost(connection);

    const program = new ElmWorkspaceMatcher((uri: string) =>
      URI.parse(uri),
    ).getProgramFor(uri);

    const clientSettings = await settings.getClientSettings();

    try {
      execCmdSync(
        clientSettings.elmPath,
        "elm",
        { cmdArguments: ["install", packageName] },
        program.getRootPath().fsPath,
        host,
        clientSettings.skipInstallPackageConfirmation ? "y\n" : undefined,
      );
    } catch (e) {
      if (clientSettings.skipInstallPackageConfirmation) {
        return;
      }

      const result: ExecaSyncReturnValue = <ExecaSyncReturnValue>e;

      const message = result.stdout.replace("[Y/n]:", "").trim();

      connection.window
        .showInformationMessage(
          message,
          { title: "Yes", value: "y" },
          { title: "No", value: "n" },
        )
        .then((choice) => {
          if (choice) {
            const cmdResult = execCmdSync(
              clientSettings.elmPath,
              "elm",
              { cmdArguments: ["install", packageName] },
              program.getRootPath().fsPath,
              host,
              `${choice.value}\n`,
            );

            const message = cmdResult.stdout.replace(result.stdout, "").trim();

            connection.window.showInformationMessage(message);
          }
        })
        .catch((e) => {
          connection.console.warn(e);
        });
    }
  },
);
