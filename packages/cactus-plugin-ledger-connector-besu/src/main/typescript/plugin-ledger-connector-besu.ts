import { Server } from "http";
import { Server as SecureServer } from "https";

import type { Server as SocketIoServer } from "socket.io";
import type { Socket as SocketIoSocket } from "socket.io";
import type { Express } from "express";
import { Optional } from "typescript-optional";

import OAS from "../json/openapi.json";

import Web3 from "web3";

import type { WebsocketProvider } from "web3-core";
//import EEAClient, { ICallOptions, IWeb3InstanceExtended } from "web3-eea";
import Web3JsQuorum, { IWeb3Quorum } from "web3js-quorum";

import { Contract, ContractSendMethod } from "web3-eth-contract";
import { TransactionReceipt } from "web3-eth";
import {
  GetBalanceV1Request,
  GetBalanceV1Response,
  Web3TransactionReceipt,
} from "./generated/openapi/typescript-axios/index";

import {
  GetPastLogsV1Request,
  GetPastLogsV1Response,
} from "./generated/openapi/typescript-axios/index";
import {
  ConsensusAlgorithmFamily,
  IPluginLedgerConnector,
  IWebServiceEndpoint,
  IPluginWebService,
  ICactusPlugin,
  ICactusPluginOptions,
} from "@hyperledger/cactus-core-api";

import {
  PluginRegistry,
  consensusHasTransactionFinality,
} from "@hyperledger/cactus-core";

import {
  Checks,
  CodedError,
  IJsObjectSignerOptions,
  JsObjectSigner,
  KeyConverter,
  KeyFormat,
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";

import { DeployContractSolidityBytecodeEndpoint } from "./web-services/deploy-contract-solidity-bytecode-endpoint";

import {
  WatchBlocksV1,
  ConsistencyStrategy,
  DeployContractSolidityBytecodeV1Request,
  DeployContractSolidityBytecodeV1Response,
  EthContractInvocationType,
  InvokeContractV1Request,
  InvokeContractV1Response,
  ReceiptType,
  RunTransactionRequest,
  RunTransactionResponse,
  SignTransactionRequest,
  SignTransactionResponse,
  Web3SigningCredentialCactusKeychainRef,
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
  GetTransactionV1Request,
  GetTransactionV1Response,
  GetBlockV1Request,
  GetBlockV1Response,
  GetBesuRecordV1Request,
  GetBesuRecordV1Response,
} from "./generated/openapi/typescript-axios";

import { InvokeContractEndpoint } from "./web-services/invoke-contract-endpoint";
import { isWeb3SigningCredentialNone } from "./model-type-guards";
import { BesuSignTransactionEndpointV1 } from "./web-services/sign-transaction-endpoint-v1";
import { PrometheusExporter } from "./prometheus-exporter/prometheus-exporter";
import {
  GetPrometheusExporterMetricsEndpointV1,
  IGetPrometheusExporterMetricsEndpointV1Options,
} from "./web-services/get-prometheus-exporter-metrics-endpoint-v1";
import { WatchBlocksV1Endpoint } from "./web-services/watch-blocks-v1-endpoint";
import { RuntimeError } from "run-time-error";
import { GetBalanceEndpoint } from "./web-services/get-balance-endpoint";
import { GetTransactionEndpoint } from "./web-services/get-transaction-endpoint";
import { GetPastLogsEndpoint } from "./web-services/get-past-logs-endpoint";
import { RunTransactionEndpoint } from "./web-services/run-transaction-endpoint";
import { GetBlockEndpoint } from "./web-services/get-block-v1-endpoint-";
import { GetBesuRecordEndpointV1 } from "./web-services/get-besu-record-endpoint-v1";
import { AbiItem } from "web3-utils";
import {
  GetOpenApiSpecV1Endpoint,
  IGetOpenApiSpecV1EndpointOptions,
} from "./web-services/get-open-api-spec-v1-endpoint";

export const E_KEYCHAIN_NOT_FOUND = "cactus.connector.besu.keychain_not_found";

export interface IPluginLedgerConnectorBesuOptions
  extends ICactusPluginOptions {
  rpcApiHttpHost: string;
  rpcApiWsHost: string;
  pluginRegistry: PluginRegistry;
  prometheusExporter?: PrometheusExporter;
  logLevel?: LogLevelDesc;
}

export class PluginLedgerConnectorBesu
  implements
    IPluginLedgerConnector<
      DeployContractSolidityBytecodeV1Request,
      DeployContractSolidityBytecodeV1Response,
      RunTransactionRequest,
      RunTransactionResponse
    >,
    ICactusPlugin,
    IPluginWebService
{
  private readonly instanceId: string;
  public prometheusExporter: PrometheusExporter;
  private readonly log: Logger;
  private readonly web3Provider: WebsocketProvider;
  private readonly web3: Web3;
  private web3Quorum: IWeb3Quorum | undefined;
  private readonly pluginRegistry: PluginRegistry;
  private contracts: {
    [name: string]: Contract;
  } = {};

  private endpoints: IWebServiceEndpoint[] | undefined;
  private httpServer: Server | SecureServer | null = null;

  public static readonly CLASS_NAME = "PluginLedgerConnectorBesu";

  public get className(): string {
    return PluginLedgerConnectorBesu.CLASS_NAME;
  }

  constructor(public readonly options: IPluginLedgerConnectorBesuOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(options.rpcApiHttpHost, `${fnTag} options.rpcApiHttpHost`);
    Checks.truthy(options.rpcApiWsHost, `${fnTag} options.rpcApiWsHost`);
    Checks.truthy(options.pluginRegistry, `${fnTag} options.pluginRegistry`);
    Checks.truthy(options.instanceId, `${fnTag} options.instanceId`);

    const level = this.options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });

    this.web3Provider = new Web3.providers.WebsocketProvider(
      this.options.rpcApiWsHost,
    );
    this.web3 = new Web3(this.web3Provider);
    this.instanceId = options.instanceId;
    this.pluginRegistry = options.pluginRegistry;
    this.prometheusExporter =
      options.prometheusExporter ||
      new PrometheusExporter({ pollingIntervalInMin: 1 });
    Checks.truthy(
      this.prometheusExporter,
      `${fnTag} options.prometheusExporter`,
    );

    this.prometheusExporter.startMetricsCollection();
  }

  public getOpenApiSpec(): unknown {
    return OAS;
  }

  public getPrometheusExporter(): PrometheusExporter {
    return this.prometheusExporter;
  }

  public async getPrometheusExporterMetrics(): Promise<string> {
    const res: string = await this.prometheusExporter.getPrometheusMetrics();
    this.log.debug(`getPrometheusExporterMetrics() response: %o`, res);
    return res;
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  public async onPluginInit(): Promise<void> {
    this.web3Quorum = Web3JsQuorum(this.web3);
  }

  public async shutdown(): Promise<void> {
    this.log.info(`Shutting down ${this.className}...`);
  }

  async registerWebServices(
    app: Express,
    wsApi: SocketIoServer,
  ): Promise<IWebServiceEndpoint[]> {
    const { web3 } = this;
    const { logLevel } = this.options;
    const webServices = await this.getOrCreateWebServices();
    await Promise.all(webServices.map((ws) => ws.registerExpress(app)));

    wsApi.on("connection", (socket: SocketIoSocket) => {
      this.log.debug(`New Socket connected. ID=${socket.id}`);

      socket.on(WatchBlocksV1.Subscribe, () => {
        new WatchBlocksV1Endpoint({ web3, socket, logLevel }).subscribe();
      });
    });
    return webServices;
  }

  public async getOrCreateWebServices(): Promise<IWebServiceEndpoint[]> {
    if (Array.isArray(this.endpoints)) {
      return this.endpoints;
    }

    const endpoints: IWebServiceEndpoint[] = [];
    {
      const endpoint = new DeployContractSolidityBytecodeEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new GetBalanceEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new GetTransactionEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new GetPastLogsEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new RunTransactionEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new GetBlockEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new InvokeContractEndpoint({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new BesuSignTransactionEndpointV1({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const endpoint = new GetBesuRecordEndpointV1({
        connector: this,
        logLevel: this.options.logLevel,
      });
      endpoints.push(endpoint);
    }
    {
      const opts: IGetPrometheusExporterMetricsEndpointV1Options = {
        connector: this,
        logLevel: this.options.logLevel,
      };
      const endpoint = new GetPrometheusExporterMetricsEndpointV1(opts);
      endpoints.push(endpoint);
    }
    {
      const oasPath =
        OAS.paths[
          "/api/v1/plugins/@hyperledger/cactus-plugin-ledger-connector-besu/get-open-api-spec"
        ];

      const operationId = oasPath.get.operationId;
      const opts: IGetOpenApiSpecV1EndpointOptions = {
        oas: OAS,
        oasPath,
        operationId,
        path: oasPath.get["x-hyperledger-cactus"].http.path,
        pluginRegistry: this.pluginRegistry,
        verbLowerCase: oasPath.get["x-hyperledger-cactus"].http.verbLowerCase,
        logLevel: this.options.logLevel,
      };
      const endpoint = new GetOpenApiSpecV1Endpoint(opts);
      endpoints.push(endpoint);
    }

    this.endpoints = endpoints;
    return endpoints;
  }

  public getPackageName(): string {
    return `@hyperledger/cactus-plugin-ledger-connector-besu`;
  }

  public async getConsensusAlgorithmFamily(): Promise<ConsensusAlgorithmFamily> {
    return ConsensusAlgorithmFamily.Authority;
  }
  public async hasTransactionFinality(): Promise<boolean> {
    const currentConsensusAlgorithmFamily =
      await this.getConsensusAlgorithmFamily();

    return consensusHasTransactionFinality(currentConsensusAlgorithmFamily);
  }

  /**
   * Verifies that it is safe to call a specific method of a Web3 Contract.
   *
   * @param contract The Web3 Contract instance to check whether it has a method with a specific name or not.
   * @param name The name of the method that will be checked if it's usable on `contract` or not.
   * @returns Boolean `true` when it IS safe to call the method named `name` on the contract.
   * @throws If the contract instance is falsy or it's methods object is falsy. Also throws if the method name is a blank string.
   */
  public async isSafeToCallContractMethod(
    contract: Contract,
    name: string,
  ): Promise<boolean> {
    Checks.truthy(
      contract,
      `${this.className}#isSafeToCallContractMethod():contract`,
    );

    Checks.truthy(
      contract.methods,
      `${this.className}#isSafeToCallContractMethod():contract.methods`,
    );

    Checks.nonBlankString(
      name,
      `${this.className}#isSafeToCallContractMethod():name`,
    );

    const { methods } = contract;

    return Object.prototype.hasOwnProperty.call(methods, name);
  }

  public async invokeContract(
    req: InvokeContractV1Request,
  ): Promise<InvokeContractV1Response> {
    const fnTag = `${this.className}#invokeContract()`;
    const contractName = req.contractName;
    let contractInstance: Contract;

    if (req.keychainId != undefined) {
      const networkId = await this.web3.eth.net.getId();
      const keychainPlugin = this.pluginRegistry.findOneByKeychainId(
        req.keychainId,
      );
      Checks.truthy(
        keychainPlugin,
        `${fnTag} keychain for ID:"${req.keychainId}"`,
      );
      if (!keychainPlugin.has(contractName)) {
        throw new Error(
          `${fnTag} Cannot create an instance of the contract because the contractName and the contractName of the JSON doesn't match`,
        );
      }
      const contractStr = await keychainPlugin.get(contractName);
      const contractJSON = JSON.parse(contractStr);
      if (
        contractJSON.networks === undefined ||
        contractJSON.networks[networkId] === undefined ||
        contractJSON.networks[networkId].address === undefined
      ) {
        if (isWeb3SigningCredentialNone(req.signingCredential)) {
          throw new Error(`${fnTag} Cannot deploy contract with pre-signed TX`);
        }
        const web3SigningCredential = req.signingCredential as
          | Web3SigningCredentialPrivateKeyHex
          | Web3SigningCredentialCactusKeychainRef;

        const receipt = await this.transact({
          transactionConfig: {
            data: `0x${contractJSON.bytecode}`,
            from: web3SigningCredential.ethAccount,
            gas: req.gas,
            gasPrice: req.gasPrice,
          },
          consistencyStrategy: {
            blockConfirmations: 0,
            receiptType: ReceiptType.NodeTxPoolAck,
            timeoutMs: req.timeoutMs || 60000,
          },
          web3SigningCredential,
          privateTransactionConfig: req.privateTransactionConfig,
        });

        const address = {
          address: receipt.transactionReceipt.contractAddress,
        };
        const network = { [networkId]: address };
        contractJSON.networks = network;
        keychainPlugin.set(contractName, JSON.stringify(contractJSON));
      }
      const contract = new this.web3.eth.Contract(
        contractJSON.abi,
        contractJSON.networks[networkId].address,
      );

      this.contracts[contractName] = contract;
    } else if (
      req.keychainId == undefined &&
      req.contractAbi == undefined &&
      req.contractAddress == undefined
    ) {
      throw new Error(
        `${fnTag} Cannot invoke a contract without contract instance, the keychainId param is needed`,
      );
    }

    contractInstance = this.contracts[contractName];
    if (req.contractAbi != undefined) {
      let abi;
      if (typeof req.contractAbi === "string") {
        abi = JSON.parse(req.contractAbi);
      } else {
        abi = req.contractAbi;
      }

      const { contractAddress } = req;
      contractInstance = new this.web3.eth.Contract(abi, contractAddress);
    }

    const isSafeToCall = await this.isSafeToCallContractMethod(
      contractInstance,
      req.methodName,
    );
    if (!isSafeToCall) {
      throw new RuntimeError(
        `Invalid method name provided in request. ${req.methodName} does not exist on the Web3 contract object's "methods" property.`,
      );
    }

    const methodRef = contractInstance.methods[req.methodName];
    Checks.truthy(methodRef, `${fnTag} YourContract.${req.methodName}`);
    const method: ContractSendMethod = methodRef(...req.params);

    if (req.invocationType === EthContractInvocationType.Call) {
      let callOutput;
      let success = false;
      if (req.privateTransactionConfig) {
        const data = method.encodeABI();
        let privKey: string;

        if (
          req.signingCredential.type ==
          Web3SigningCredentialType.CactusKeychainRef
        ) {
          const { keychainEntryKey, keychainId } =
            req.signingCredential as Web3SigningCredentialCactusKeychainRef;

          const keychainPlugin =
            this.pluginRegistry.findOneByKeychainId(keychainId);
          privKey = await keychainPlugin?.get(keychainEntryKey);
        } else {
          privKey = (
            req.signingCredential as Web3SigningCredentialPrivateKeyHex
          ).secret;
        }

        const fnParams = {
          to: contractInstance.options.address,
          data,
          privateFrom: req.privateTransactionConfig.privateFrom,
          privateKey: privKey,
          privateFor: req.privateTransactionConfig.privateFor,
        };
        if (!this.web3Quorum) {
          throw new RuntimeError(`InvalidState: web3Quorum not initialized.`);
        }

        const privacyGroupId =
          this.web3Quorum.utils.generatePrivacyGroup(fnParams);
        this.log.debug("Generated privacyGroupId: ", privacyGroupId);
        callOutput = await this.web3Quorum.priv.call(privacyGroupId, {
          to: contractInstance.options.address,
          data,
          // TODO: Update the "from" property of ICallOptions to be optional
        });

        success = true;
        this.log.debug(`Web3 EEA Call output: `, callOutput);
      } else {
        callOutput = await method.call();
        success = true;
      }
      return { success, callOutput };
    } else if (req.invocationType === EthContractInvocationType.Send) {
      if (isWeb3SigningCredentialNone(req.signingCredential)) {
        throw new Error(`${fnTag} Cannot deploy contract with pre-signed TX`);
      }
      const web3SigningCredential = req.signingCredential as
        | Web3SigningCredentialPrivateKeyHex
        | Web3SigningCredentialCactusKeychainRef;
      const payload = (method.send as any).request();
      const { params } = payload;
      const [transactionConfig] = params;
      if (req.gas == undefined) {
        req.gas = await this.web3.eth.estimateGas(transactionConfig);
      }
      transactionConfig.from = web3SigningCredential.ethAccount;
      transactionConfig.gas = req.gas;
      transactionConfig.gasPrice = req.gasPrice;
      transactionConfig.value = req.value;
      transactionConfig.nonce = req.nonce;
      const txReq: RunTransactionRequest = {
        transactionConfig,
        web3SigningCredential,
        consistencyStrategy: {
          blockConfirmations: 0,
          receiptType: ReceiptType.NodeTxPoolAck,
          timeoutMs: req.timeoutMs || 60000,
        },
        privateTransactionConfig: req.privateTransactionConfig,
      };
      const out = await this.transact(txReq);
      const success = out.transactionReceipt.status;
      const data = { success, out };
      return data;
    } else {
      throw new Error(
        `${fnTag} Unsupported invocation type ${req.invocationType}`,
      );
    }
  }

  public async transact(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transact()`;

    switch (req.web3SigningCredential.type) {
      // Web3SigningCredentialType.GETHKEYCHAINPASSWORD is removed as Hyperledger Besu doesn't support the PERSONAL api
      // for --rpc-http-api as per the discussion mentioned here
      // https://chat.hyperledger.org/channel/besu-contributors?msg=GqQXfW3k79ygRtx5Q
      case Web3SigningCredentialType.CactusKeychainRef: {
        return this.transactCactusKeychainRef(req);
      }
      case Web3SigningCredentialType.PrivateKeyHex: {
        return this.transactPrivateKey(req);
      }
      case Web3SigningCredentialType.None: {
        if (req.transactionConfig.rawTransaction) {
          return this.transactSigned(req);
        } else {
          throw new Error(
            `${fnTag} Expected pre-signed raw transaction ` +
              ` since signing credential is specified as` +
              `Web3SigningCredentialType.NONE`,
          );
        }
      }
      default: {
        throw new Error(
          `${fnTag} Unrecognized Web3SigningCredentialType: ` +
            `${req.web3SigningCredential.type} Supported ones are: ` +
            `${Object.values(Web3SigningCredentialType).join(";")}`,
        );
      }
    }
  }

  public async transactSigned(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactSigned()`;

    Checks.truthy(req.consistencyStrategy, `${fnTag}:req.consistencyStrategy`);
    Checks.truthy(
      req.transactionConfig.rawTransaction,
      `${fnTag}:req.transactionConfig.rawTransaction`,
    );
    const rawTx = req.transactionConfig.rawTransaction as string;

    this.log.debug("Starting web3.eth.sendSignedTransaction(rawTransaction) ");

    const txPoolReceipt = await this.web3.eth.sendSignedTransaction(rawTx);

    return this.getTxReceipt(req, txPoolReceipt);
  }

  public async getTxReceipt(
    request: RunTransactionRequest,
    txPoolReceipt: TransactionReceipt,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#getTxReceipt()`;

    this.log.debug("Received preliminary receipt from Besu node.");

    if (txPoolReceipt instanceof Error) {
      this.log.debug(`${fnTag} sendSignedTransaction failed`, txPoolReceipt);
      throw txPoolReceipt;
    }
    this.prometheusExporter.addCurrentTransaction();

    if (
      request.consistencyStrategy.receiptType === ReceiptType.NodeTxPoolAck &&
      request.consistencyStrategy.blockConfirmations > 0
    ) {
      throw new Error(
        `${fnTag} Conflicting parameters for consistency` +
          ` strategy: Cannot wait for >0 block confirmations AND only wait ` +
          ` for the tx pool ACK at the same time.`,
      );
    }

    switch (request.consistencyStrategy.receiptType) {
      case ReceiptType.NodeTxPoolAck:
        return { transactionReceipt: txPoolReceipt };
      case ReceiptType.LedgerBlockAck:
        this.log.debug("Starting poll for ledger TX receipt ...");
        const txHash = txPoolReceipt.transactionHash;
        const { consistencyStrategy } = request;
        const ledgerReceipt = await this.pollForTxReceipt(
          txHash,
          consistencyStrategy,
        );
        this.log.debug(
          "Finished poll for ledger TX receipt: %o",
          ledgerReceipt,
        );
        return { transactionReceipt: ledgerReceipt };
      default:
        throw new Error(
          `${fnTag} Unrecognized ReceiptType: ${request.consistencyStrategy.receiptType}`,
        );
    }
  }

  public async transactPrivate(options: any): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactPrivate()`;

    if (!this.web3Quorum) {
      throw new Error(`${fnTag} Web3 EEA client not initialized.`);
    }

    const txHash = await this.web3Quorum.priv.generateAndSendRawTransaction(
      options,
    );

    if (!txHash) {
      throw new Error(`${fnTag} eea.sendRawTransaction provided no tx hash.`);
    }
    return this.getPrivateTxReceipt(options.privateFrom, txHash);
  }

  public async getPrivateTxReceipt(
    privateFrom: string,
    txHash: string,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#getPrivateTxReceipt()`;

    if (!this.web3Quorum) {
      throw new Error(`${fnTag} Web3 Quorum client not initialized.`);
    }

    const txPoolReceipt = await this.web3Quorum.priv.waitForTransactionReceipt(
      txHash,
    );
    if (!txPoolReceipt) {
      throw new RuntimeError(`priv.getTransactionReceipt provided no receipt.`);
    }

    return {
      transactionReceipt: txPoolReceipt as unknown as Web3TransactionReceipt,
    };
  }

  public async transactPrivateKey(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactPrivateKey()`;
    const { transactionConfig, web3SigningCredential } = req;
    const { secret } =
      web3SigningCredential as Web3SigningCredentialPrivateKeyHex;

    // Run transaction to EEA client here if private transaction

    if (req.privateTransactionConfig) {
      const options = {
        nonce: transactionConfig.nonce,
        gasPrice: transactionConfig.gasPrice,
        gasLimit: transactionConfig.gas,
        to: transactionConfig.to,
        value: transactionConfig.value,
        data: transactionConfig.data,
        privateKey: secret,
        privateFrom: req.privateTransactionConfig.privateFrom,
        privateFor: req.privateTransactionConfig.privateFor,
        restriction: "restricted",
      };

      return this.transactPrivate(options);
    }

    const signedTx = await this.web3.eth.accounts.signTransaction(
      transactionConfig,
      secret,
    );

    if (signedTx.rawTransaction) {
      req.transactionConfig.rawTransaction = signedTx.rawTransaction;
      return this.transactSigned(req);
    } else {
      throw new Error(
        `${fnTag} Failed to sign eth transaction. ` +
          `signedTransaction.rawTransaction is blank after .signTransaction().`,
      );
    }
  }

  public async transactCactusKeychainRef(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactCactusKeychainRef()`;
    const {
      transactionConfig,
      web3SigningCredential,
      privateTransactionConfig,
    } = req;
    const { ethAccount, keychainEntryKey, keychainId } =
      web3SigningCredential as Web3SigningCredentialCactusKeychainRef;

    // locate the keychain plugin that has access to the keychain backend
    // denoted by the keychainID from the request.
    const keychainPlugin = this.pluginRegistry.findOneByKeychainId(keychainId);

    Checks.truthy(keychainPlugin, `${fnTag} keychain for ID:"${keychainId}"`);

    // Now use the found keychain plugin to actually perform the lookup of
    // the private key that we need to run the transaction.
    const privateKeyHex = await keychainPlugin?.get(keychainEntryKey);

    return this.transactPrivateKey({
      privateTransactionConfig,
      transactionConfig,
      web3SigningCredential: {
        ethAccount,
        type: Web3SigningCredentialType.PrivateKeyHex,
        secret: privateKeyHex,
      },
      consistencyStrategy: {
        blockConfirmations: 0,
        receiptType: ReceiptType.NodeTxPoolAck,
        timeoutMs: 60000,
      },
    });
  }

  public async pollForTxReceipt(
    txHash: string,
    consistencyStrategy: ConsistencyStrategy,
  ): Promise<TransactionReceipt> {
    const fnTag = `${this.className}#pollForTxReceipt()`;
    let txReceipt;
    let timedOut = false;
    let tries = 0;
    let confirmationCount = 0;
    const timeoutMs = consistencyStrategy.timeoutMs || Number.MAX_SAFE_INTEGER;
    const startedAt = new Date();

    do {
      tries++;
      timedOut = Date.now() >= startedAt.getTime() + timeoutMs;
      if (timedOut) {
        break;
      }

      txReceipt = await this.web3.eth.getTransactionReceipt(txHash);
      if (!txReceipt) {
        continue;
      }

      const latestBlockNo = await this.web3.eth.getBlockNumber();
      confirmationCount = latestBlockNo - txReceipt.blockNumber;
    } while (confirmationCount >= consistencyStrategy.blockConfirmations);

    if (!txReceipt) {
      throw new Error(`${fnTag} Timed out ${timeoutMs}ms, polls=${tries}`);
    }
    return txReceipt;
  }

  public async deployContract(
    req: DeployContractSolidityBytecodeV1Request,
  ): Promise<DeployContractSolidityBytecodeV1Response> {
    const fnTag = `${this.className}#deployContract()`;
    Checks.truthy(req, `${fnTag} req`);
    if (isWeb3SigningCredentialNone(req.web3SigningCredential)) {
      throw new Error(`${fnTag} Cannot deploy contract with pre-signed TX`);
    }
    const { contractName } = req;
    if (req.keychainId != undefined && req.contractName != undefined) {
      const keychainPlugin = this.pluginRegistry.findOneByKeychainId(
        req.keychainId,
      );
      Checks.truthy(
        keychainPlugin,
        `${fnTag} keychain for ID:"${req.keychainId}"`,
      );
      if (!keychainPlugin.has(req.contractName)) {
        throw new Error(
          `${fnTag} Cannot create an instance of the contract because the contractName and the contractName on the keychain does not match`,
        );
      }
      const networkId = await this.web3.eth.net.getId();

      const tmpContract = new this.web3.eth.Contract(req.contractAbi);
      const deployment = tmpContract.deploy({
        data: req.bytecode,
        arguments: req.constructorArgs,
      });

      const abi = deployment.encodeABI();
      const data = abi.startsWith("0x") ? abi : `0x${abi}`;
      this.log.debug(`Deploying "${req.contractName}" with data %o`, data);

      const web3SigningCredential = req.web3SigningCredential as
        | Web3SigningCredentialPrivateKeyHex
        | Web3SigningCredentialCactusKeychainRef;

      const runTxResponse = await this.transact({
        transactionConfig: {
          data,
          from: web3SigningCredential.ethAccount,
          gas: req.gas,
          gasPrice: req.gasPrice,
        },
        consistencyStrategy: {
          blockConfirmations: 0,
          receiptType: ReceiptType.NodeTxPoolAck,
          timeoutMs: req.timeoutMs || 60000,
        },
        web3SigningCredential,
        privateTransactionConfig: req.privateTransactionConfig,
      });

      const keychainHasContract = await keychainPlugin.has(contractName);
      if (keychainHasContract) {
        this.log.debug(`Keychain has the contract, updating networks...`);

        const { transactionReceipt: receipt } = runTxResponse;
        const { status, contractAddress } = receipt;

        if (status && contractAddress) {
          const networkInfo = { address: contractAddress };
          const contractStr = await keychainPlugin.get(contractName);
          const contractJSON = JSON.parse(contractStr);
          this.log.debug("Contract JSON: \n%o", JSON.stringify(contractJSON));
          const contract = new this.web3.eth.Contract(
            contractJSON.abi,
            contractAddress,
          );
          this.contracts[contractName] = contract;

          const network = { [networkId]: networkInfo };
          contractJSON.networks = network;

          await keychainPlugin.set(contractName, JSON.stringify(contractJSON));
        }
      } else {
        throw new Error(
          `${fnTag} Cannot create an instance of the contract because the contractName and the contractName on the keychain does not match`,
        );
      }

      // creating solidity byte code response
      const deployResponse: DeployContractSolidityBytecodeV1Response = {
        transactionReceipt: runTxResponse.transactionReceipt,
      };

      return deployResponse;
    }
    throw new Error(
      `${fnTag} Cannot deploy contract without keychainId and the contractName`,
    );
  }

  public async signTransaction(
    req: SignTransactionRequest,
  ): Promise<Optional<SignTransactionResponse>> {
    const { pluginRegistry, rpcApiHttpHost, logLevel } = this.options;
    const { keychainId, keychainRef, transactionHash } = req;

    const converter = new KeyConverter();

    const web3Provider = new Web3.providers.HttpProvider(rpcApiHttpHost);
    const web3 = new Web3(web3Provider);

    // Make sure the transaction exists on the ledger first...
    const transaction = await web3.eth.getTransaction(transactionHash);
    if (!transaction) {
      return Optional.empty();
    }

    const keychain = pluginRegistry.findOneByKeychainId(keychainId);

    if (!keychain) {
      const msg = `Keychain for ID ${keychainId} not found.`;
      throw new CodedError(msg, E_KEYCHAIN_NOT_FOUND);
    }

    const pem: string = await keychain.get(keychainRef);

    const pkRaw = converter.privateKeyAs(pem, KeyFormat.PEM, KeyFormat.Raw);

    const jsObjectSignerOptions: IJsObjectSignerOptions = {
      privateKey: pkRaw,
      logLevel,
    };

    const jsObjectSigner = new JsObjectSigner(jsObjectSignerOptions);

    if (transaction !== undefined && transaction !== null) {
      const singData = jsObjectSigner.sign(transaction.input);
      const signDataHex = Buffer.from(singData).toString("hex");

      const resBody: SignTransactionResponse = { signature: signDataHex };
      return Optional.ofNullable(resBody);
    }

    return Optional.empty();
  }

  public async getBalance(
    request: GetBalanceV1Request,
  ): Promise<GetBalanceV1Response> {
    const balance = await this.web3.eth.getBalance(
      request.address,
      request.defaultBlock,
    );
    return { balance };
  }

  public async getTransaction(
    request: GetTransactionV1Request,
  ): Promise<GetTransactionV1Response> {
    const transaction = await this.web3.eth.getTransaction(
      request.transactionHash,
    );
    return { transaction };
  }

  public async getPastLogs(
    request: GetPastLogsV1Request,
  ): Promise<GetPastLogsV1Response> {
    const logs = await this.web3.eth.getPastLogs(request);
    return { logs };
  }

  public async getBlock(
    request: GetBlockV1Request,
  ): Promise<GetBlockV1Response> {
    const block = await this.web3.eth.getBlock(request.blockHashOrBlockNumber);
    return { block };
  }
  public async getBesuRecord(
    request: GetBesuRecordV1Request,
  ): Promise<GetBesuRecordV1Response> {
    const fnTag = `${this.className}#getBesuRecord()`;
    //////////////////////////////////////////////
    let abi: AbiItem[] | AbiItem = [];
    const resp: GetBesuRecordV1Response = {};
    const txHash = request.transactionHash;

    if (txHash) {
      const transaction = await this.web3.eth.getTransaction(txHash);
      if (transaction.input) {
        resp.transactionInputData = transaction.input;
        return resp;
      }
    }

    if (request.invokeCall) {
      if (request.invokeCall.contractAbi) {
        if (typeof request.invokeCall.contractAbi === "string") {
          abi = JSON.parse(request.invokeCall.contractAbi);
        } else {
          abi = request.invokeCall.contractAbi;
        }
      }
      const { contractAddress } = request.invokeCall;
      const contractInstance = new this.web3.eth.Contract(abi, contractAddress);

      const isSafeToCall = await this.isSafeToCallContractMethod(
        contractInstance,
        request.invokeCall.methodName,
      );
      if (!isSafeToCall) {
        throw new RuntimeError(
          `Invalid method name provided in request. ${request.invokeCall.methodName} does not exist on the Web3 contract object's "methods" property.`,
        );
      }

      const methodRef = contractInstance.methods[request.invokeCall.methodName];
      Checks.truthy(
        methodRef,
        `${fnTag} YourContract.${request.invokeCall.methodName}`,
      );
      const method: ContractSendMethod = methodRef(
        ...request.invokeCall.params,
      );

      if (
        request.invokeCall.invocationType === EthContractInvocationType.Call
      ) {
        const callOutput = await (method as any).call();
        const res: GetBesuRecordV1Response = {
          callOutput,
        };
        return res;
      } else {
        throw new Error(
          `${fnTag} Unsupported invocation type ${request.invokeCall.invocationType}`,
        );
      }
    }
    return resp;
  }
}
