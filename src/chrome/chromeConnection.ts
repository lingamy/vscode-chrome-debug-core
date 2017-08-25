/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as WebSocket from 'ws';

import {telemetry} from '../telemetry';
import * as errors from '../errors';
import * as utils from '../utils';
import {logger} from 'vscode-debugadapter';
import {ChromeTargetDiscovery} from './chromeTargetDiscoveryStrategy';

import {Client, LikeSocket} from 'noice-json-rpc';

import Crdp from '../../crdp/crdp';

import {CRDPMultiplexor} from './crdpMultiplexing/crdpMultiplexor';
import {WebSocketToLikeSocketProxy} from './crdpMultiplexing/webSocketToLikeSocketProxy';

export interface ITarget {
    description: string;
    devtoolsFrontendUrl: string;
    id: string;
    thumbnailUrl?: string;
    title: string;
    type: string;
    url?: string;
    webSocketDebuggerUrl: string;
}

export type ITargetFilter = (target: ITarget) => boolean;
export interface ITargetDiscoveryStrategy {
    getTarget(address: string, port: number, targetFilter?: ITargetFilter, targetUrl?: string): Promise<string>;
    getAllTargets(address: string, port: number, targetFilter?: ITargetFilter, targetUrl?: string): Promise<ITarget[]>;
}

/**
 * A subclass of WebSocket that logs all traffic
 */
class LoggingSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[], options?: WebSocket.IClientOptions) {
        super(address, protocols, options);

        this.on('error', e => {
            logger.log('Websocket error: ' + e.toString());
        });

        this.on('close', () => {
            logger.log('Websocket closed');
        });

        this.on('message', msgStr => {
            let msgObj: any;
            try {
                msgObj = JSON.parse(msgStr);
            } catch (e) {
                logger.error(`Invalid JSON from target: (${e.message}): ${msgStr}`);
                return;
            }

            if (msgObj && !(msgObj.method && msgObj.method.startsWith('Network.'))) {
                // Not really the right place to examine the content of the message, but don't log annoying Network activity notifications.
                logger.verbose('← From target: ' + msgStr);
            }
        });
    }

    public send(data: any, cb?: (err: Error) => void): void {
        super.send.apply(this, arguments);

        const msgStr = JSON.stringify(data);
        logger.verbose('→ To target: ' + msgStr);
    }
}

export interface IChromeError {
    code: number;
    message: string;
    data: string;
}

/**
 * Connects to a target supporting the Chrome Debug Protocol and sends and receives messages
 */
export class ChromeConnection {
    private static ATTACH_TIMEOUT = 10000; // ms

    private _socket: WebSocket;
    private _crdpSocketMultiplexor: CRDPMultiplexor;
    private _client: Client;
    private _targetFilter: ITargetFilter;
    private _targetDiscoveryStrategy: ITargetDiscoveryStrategy;

    constructor(targetDiscovery?: ITargetDiscoveryStrategy, targetFilter?: ITargetFilter) {
        this._targetFilter = targetFilter;
        this._targetDiscoveryStrategy = targetDiscovery || new ChromeTargetDiscovery(logger, telemetry);
    }

    public get isAttached(): boolean { return !!this._client; }

    public get api(): Crdp.CrdpClient {
        return this._client && this._client.api();
    }

    /**
     * Attach the websocket to the first available tab in the chrome instance with the given remote debugging port number.
     */
    public attach(address = '127.0.0.1', port = 9222, targetUrl?: string, timeout?: number, extraCRDPChannelPorts?: number[], channelWithNoDebuggerNotification?: number): Promise<void> {
        return this._attach(address, port, targetUrl, timeout, extraCRDPChannelPorts, channelWithNoDebuggerNotification)
            .then(() => { });
    }

    public attachToWebsocketUrl(wsUrl: string, extraCRDPChannelPorts?: number[], channelWithNoDebuggerNotification? : number): void {
        this._socket = new LoggingSocket(wsUrl);
        if (extraCRDPChannelPorts && extraCRDPChannelPorts.length >= 1) {
            this._crdpSocketMultiplexor = new CRDPMultiplexor(this._socket as any as LikeSocket, channelWithNoDebuggerNotification ? channelWithNoDebuggerNotification.toString() : '');
            extraCRDPChannelPorts.forEach(extraCRDPChannelPort => {
                new WebSocketToLikeSocketProxy(extraCRDPChannelPort, this._crdpSocketMultiplexor.addChannel(`extraCRDPEndpoint ${extraCRDPChannelPort}`)).start();
            });
            this._client = new Client(this._crdpSocketMultiplexor.addChannel('debugger'));
        } else {
            this._client = new Client(<WebSocket>this._socket as any);
        }

        this._client.on('error', e => logger.error('Error handling message from target: ' + e.message));
    }

    private _attach(address: string, port: number, targetUrl?: string, timeout = ChromeConnection.ATTACH_TIMEOUT, extraCRDPChannelPorts?: number[], channelWithNoDebuggerNotification?: number): Promise<void> {
        return utils.retryAsync(() => this._targetDiscoveryStrategy.getTarget(address, port, this._targetFilter, targetUrl), timeout, /*intervalDelay=*/200)
            .catch(err => Promise.reject(errors.runtimeConnectionTimeout(timeout, err.message)))
            .then(wsUrl => {
                return this.attachToWebsocketUrl(wsUrl, extraCRDPChannelPorts, channelWithNoDebuggerNotification);
            });
    }

    public run(): Promise<void> {
        // This is a CDP version difference which will have to be handled more elegantly with others later...
        // For now, we need to send both messages and ignore a failing one.
        return Promise.all([
            this.api.Runtime.runIfWaitingForDebugger(),
            (<any>this.api.Runtime).run()
        ])
        .then(() => { }, e => { });
    }

    public close(): void {
        this._socket.close();
    }

    public onClose(handler: () => void): void {
        this._socket.on('close', handler);
    }
}
