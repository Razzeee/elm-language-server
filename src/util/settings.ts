import { ClientCapabilities, Connection } from "vscode-languageserver";
import { injectable, container } from "tsyringe";

export interface IClientSettings {
  elmFormatPath: string;
  elmPath: string;
  elmTestPath: string;
  trace: { server: string };
  extendedCapabilities?: IExtendedCapabilites;
  disableElmLSDiagnostics: boolean;
  skipInstallPackageConfirmation: boolean;
  onlyUpdateDiagnosticsOnSave: boolean;
}

export interface IExtendedCapabilites {
  moveFunctionRefactoringSupport: boolean;
  exposeUnexposeSupport: boolean;
  clientInitiatedDiagnostics: boolean;
}

export function getDefaultSettings(): IClientSettings {
  return {
    elmFormatPath: "",
    elmPath: "",
    elmTestPath: "",
    trace: { server: "off" },
    disableElmLSDiagnostics: false,
    skipInstallPackageConfirmation: false,
    onlyUpdateDiagnosticsOnSave: false,
  };
}
@injectable()
export class Settings {
  private clientSettings: IClientSettings = getDefaultSettings();
  private connection: Connection;

  private initDone = false;

  constructor(
    config: IClientSettings,
    private clientCapabilities: ClientCapabilities,
  ) {
    this.connection = container.resolve<Connection>("Connection");
    this.updateSettings(config);
  }

  public initFinished(): void {
    this.initDone = true;
  }

  public async getClientSettings(): Promise<IClientSettings> {
    if (
      this.initDone &&
      this.clientCapabilities.workspace &&
      this.clientCapabilities.workspace.configuration
    ) {
      this.updateSettings(
        await this.connection.workspace.getConfiguration("elmLS"),
      );
    }
    return this.clientSettings;
  }

  public get extendedCapabilities(): IExtendedCapabilites | undefined {
    return this.clientSettings.extendedCapabilities;
  }

  private updateSettings(config: IClientSettings): void {
    this.clientSettings = { ...this.clientSettings, ...config };
  }
}
