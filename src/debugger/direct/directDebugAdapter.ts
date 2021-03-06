// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as path from "path";
import { ProjectVersionHelper } from "../../common/projectVersionHelper";
import { ReactNativeProjectHelper } from "../../common/reactNativeProjectHelper";
import { ErrorHelper } from "../../common/error/errorHelper";
import { getExtensionVersion } from "../../common/extensionHelper";
import { ILaunchArgs } from "../../extension/launchArgs";
import { getProjectRoot } from "../nodeDebugWrapper";
import { Telemetry } from "../../common/telemetry";
import { OutputEvent, Logger } from "vscode-debugadapter";
import { TelemetryHelper } from "../../common/telemetryHelper";
import { RemoteTelemetryReporter } from "../../common/telemetryReporters";
import { ChromeDebugAdapter, ChromeDebugSession, IChromeDebugSessionOpts, IAttachRequestArgs, logger, IOnPausedResult, Crdp } from "vscode-chrome-debug-core";
import { InternalErrorCode } from "../../common/error/internalErrorCode";
import { RemoteExtension } from "../../common/remoteExtension";
import { DebugProtocol } from "vscode-debugprotocol";
import { getLoggingDirectory } from "../../extension/log/LogHelper";
import * as nls from "vscode-nls";
import * as Q from "q";
const localize = nls.loadMessageBundle();

export interface IDirectAttachRequestArgs extends IAttachRequestArgs, ILaunchArgs {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
}

export interface IDirectLaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, IDirectAttachRequestArgs { }

export class DirectDebugAdapter extends ChromeDebugAdapter {

    /**
     * @description The Hermes native functions calls mark in call stack
     * @type {string}
     */
    private static HERMES_NATIVE_FUNCTION_NAME: string = "(native)";

    /**
     * @description Equals to 0xfffffff - the scriptId returned by Hermes debugger, that means "invalid script ID"
     * @type {string}
     */
    private static HERMES_NATIVE_FUNCTION_SCRIPT_ID: string = "4294967295";

    private outputLogger: (message: string, error?: boolean | string) => void;
    private projectRootPath: string;
    private remoteExtension: RemoteExtension;
    private isSettingsInitialized: boolean; // used to prevent parameters reinitialization when attach is called from launch function
    private previousAttachArgs: IDirectAttachRequestArgs;

    public constructor(opts: IChromeDebugSessionOpts, debugSession: ChromeDebugSession) {
        super(opts, debugSession);
        this.outputLogger = (message: string, error?: boolean | string) => {
            let category = "console";
            if (error === true) {
                category = "stderr";
            }
            if (typeof error === "string") {
                category = error;
            }

            let newLine = "\n";
            if (category === "stdout" || category === "stderr") {
                newLine = "";
            }
            debugSession.sendEvent(new OutputEvent(message + newLine, category));
        };

        this.isSettingsInitialized = false;
    }

    public launch(launchArgs: IDirectLaunchRequestArgs): Promise<void>  {
        let extProps = {
            platform: {
                value: launchArgs.platform,
                isPii: false,
            },
            isDirect: {
                value: true,
                isPii: false,
            },
        };

        return new Promise<void>((resolve, reject) => this.initializeSettings(launchArgs)
            .then(() => {
                this.outputLogger("Launching the application");
                logger.verbose(`Launching the application: ${JSON.stringify(launchArgs, null , 2)}`);
                return ProjectVersionHelper.getReactNativeVersions(launchArgs.cwd, launchArgs.platform === "windows")
                    .then(versions => {
                        extProps = TelemetryHelper.addPropertyToTelemetryProperties(versions.reactNativeVersion, "reactNativeVersion", extProps);
                        if (launchArgs.platform === "windows") {
                            extProps = TelemetryHelper.addPropertyToTelemetryProperties(versions.reactNativeWindowsVersion, "reactNativeWindowsVersion", extProps);
                        }
                        return TelemetryHelper.generate("launch", extProps, (generator) => {
                            return this.remoteExtension.launch({ "arguments": launchArgs })
                                .then(() => {
                                    return this.remoteExtension.getPackagerPort(launchArgs.cwd);
                                })
                                .then((packagerPort: number) => {
                                    launchArgs.port = launchArgs.port || packagerPort;
                                    this.attach(launchArgs).then(() => {
                                        resolve();
                                    }).catch((e) => reject(e));
                                }).catch((e) => reject(e));
                        })
                        .catch((err) => {
                            this.outputLogger("An error occurred while launching the application. " + err.message || err, true);
                            this.cleanUp();
                            reject(err);
                        });
                    });
        }));
    }

    public attach(attachArgs: IDirectAttachRequestArgs): Promise<void> {
        let extProps = {
            platform: {
                value: attachArgs.platform,
                isPii: false,
            },
            isDirect: {
                value: true,
                isPii: false,
            },
        };

        this.previousAttachArgs = attachArgs;

        return new Promise<void>((resolve, reject) => this.initializeSettings(attachArgs)
            .then(() => {
                this.outputLogger("Attaching to the application");
                logger.verbose(`Attaching to the application: ${JSON.stringify(attachArgs, null , 2)}`);
                return ProjectVersionHelper.getReactNativeVersions(attachArgs.cwd, true)
                    .then(versions => {
                        extProps = TelemetryHelper.addPropertyToTelemetryProperties(versions.reactNativeVersion, "reactNativeVersion", extProps);
                        if (!ProjectVersionHelper.isVersionError(versions.reactNativeWindowsVersion)) {
                            extProps = TelemetryHelper.addPropertyToTelemetryProperties(versions.reactNativeWindowsVersion, "reactNativeWindowsVersion", extProps);
                        }
                        return TelemetryHelper.generate("attach", extProps, (generator) => {
                            return this.remoteExtension.getPackagerPort(attachArgs.cwd)
                                .then((packagerPort: number) => {
                                    attachArgs.port = attachArgs.port || packagerPort;
                                    this.outputLogger(`Connecting to ${attachArgs.port} port`);
                                    const attachArguments = Object.assign({}, attachArgs, {
                                        address: "localhost",
                                        port: attachArgs.port,
                                        restart: true,
                                        request: "attach",
                                        remoteRoot: undefined,
                                        localRoot: undefined,
                                    });
                                    super.attach(attachArguments).then(() => {
                                        this.outputLogger("The debugger attached successfully");
                                        resolve();
                                    }).catch((e) => reject(e));
                                }).catch((e) => reject(e));
                        })
                        .catch((err) => {
                            this.outputLogger("An error occurred while attaching to the debugger. " + err.message || err, true);
                            this.cleanUp();
                            reject(err);
                        });
                    });
        }));
    }

    public disconnect(args: DebugProtocol.DisconnectArguments): void {
        this.cleanUp();
        super.disconnect(args);
    }

    protected async onPaused(notification: Crdp.Debugger.PausedEvent, expectingStopReason = this._expectingStopReason): Promise<IOnPausedResult> {
        // Excluding Hermes native function calls from call stack, since VS Code can't process them properly
        // More info: https://github.com/facebook/hermes/issues/168
        notification.callFrames = notification.callFrames.filter(callFrame =>
            callFrame.functionName !== DirectDebugAdapter.HERMES_NATIVE_FUNCTION_NAME &&
            callFrame.location.scriptId !== DirectDebugAdapter.HERMES_NATIVE_FUNCTION_SCRIPT_ID
            );
        return super.onPaused(notification, expectingStopReason);
    }

    private initializeSettings(args: any): Q.Promise<any> {
        if (!this.isSettingsInitialized) {
            let chromeDebugCoreLogs = getLoggingDirectory();
            if (chromeDebugCoreLogs) {
                chromeDebugCoreLogs = path.join(chromeDebugCoreLogs, "ChromeDebugCoreLogs.txt");
            }
            let logLevel: string = args.trace;
            if (logLevel) {
                logLevel = logLevel.replace(logLevel[0], logLevel[0].toUpperCase());
                logger.setup(Logger.LogLevel[logLevel], chromeDebugCoreLogs || false);
            } else {
                logger.setup(Logger.LogLevel.Log, chromeDebugCoreLogs || false);
            }

            if (!args.sourceMaps) {
                args.sourceMaps = true;
            }

            const projectRootPath = getProjectRoot(args);
            return ReactNativeProjectHelper.isReactNativeProject(projectRootPath)
            .then((result) => {
                if (!result) {
                    throw ErrorHelper.getInternalError(InternalErrorCode.NotInReactNativeFolderError);
                }
                this.projectRootPath = projectRootPath;
                this.remoteExtension = RemoteExtension.atProjectRootPath(this.projectRootPath);
                const version = getExtensionVersion();

                // Start to send telemetry
                (this._session as any).getTelemetryReporter().reassignTo(new RemoteTelemetryReporter(
                    "react-native-tools", version, Telemetry.APPINSIGHTS_INSTRUMENTATIONKEY, this.projectRootPath));

                this.isSettingsInitialized = true;

                return void 0;
            });
        } else {
            return Q.resolve<void>(void 0);
        }
    }

    private cleanUp() {
        if (this.previousAttachArgs.platform === "android") {
            this.remoteExtension.stopMonitoringLogcat()
                .catch(reason => logger.warn(localize("CouldNotStopMonitoringLogcat", "Couldn't stop monitoring logcat: {0}", reason.message || reason)))
                .finally(() => super.disconnect({terminateDebuggee: true}));
        }
    }

}
