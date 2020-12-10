'use strict';

const util = require('util');
const assert = require('bsert');
const custom = require('../../lib/utils/inspect');
const hd = require('bcoin/lib/hd');
const Network = require('bcoin/lib/protocol/network');
const hash160 = require('bcrypto/lib/hash160');
const secp256k1 = require('bcrypto/lib/secp256k1');

const Cosigner = require('../../lib/primitives/cosigner');
const sigUtils = require('../../lib/utils/sig');

const NULL_TOKEN = Buffer.alloc(32, 0x00);
const EMPTY = Buffer.alloc(0);

class CosignerContext {
  constructor(options) {
    this.network = Network.main;
    this.master = null;
    this.accountKey = null;
    this.purpose = 44;
    this.fingerPrint = 0;
    this.name = 'cosigner';
    this.data = EMPTY;
    this.walletName = '';

    this.token = NULL_TOKEN;

    this.authPrivKey = null;
    this.authPubKey = null;

    this.joinPrivKey = null;
    this.joinPubKey = null;

    this._joinHash = null;
    this._joinSignature = null;
    this._xpubProof = null;
    this._cosigner = null;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    if (options.name != null) {
      assert(typeof options.name === 'string');
      this.name = options.name;
    }

    if (options.walletName != null) {
      assert(typeof options.walletName === 'string');
      this.walletName = options.walletName;
    }

    if (options.token != null) {
      assert(Buffer.isBuffer(options.token));
      this.token = options.token;
    }

    if (options.data != null) {
      assert(Buffer.isBuffer(options.data));
      this.data = options.data;
    }

    if (options.network != null)
      this.network = Network.get(options.network);

    let master;
    if (options.master != null) {
      assert(hd.PrivateKey.isHDPrivateKey(options.master),
        'Bad master key.');
      master = options.master;
    } else {
      master = hd.generate();
    }

    let joinPrivKey;
    if (options.joinPrivKey != null) {
      assert(Buffer.isBuffer(options.joinPrivKey),
        'joinPrivKey must be a buffer.');
      assert(secp256k1.privateKeyVerify(options.joinPrivKey),
        'joinPrivKey is not a private key.');
      joinPrivKey = options.joinPrivKey;
    } else {
      joinPrivKey = secp256k1.privateKeyGenerate();
    }

    let authPrivKey;
    if (options.authPrivKey != null) {
      assert(Buffer.isBuffer(options.authPrivKey),
        'authPrivKey must be a buffer.');
      assert(secp256k1.privateKeyVerify(options.authPrivKey),
        'authPrivKey is not a private key.');

      authPrivKey = options.authPrivKey;
    } else {
      authPrivKey = secp256k1.privateKeyGenerate();
    }

    this.joinPrivKey = joinPrivKey;
    this.authPrivKey = authPrivKey;
    this.master = master;

    this.init();
  }

  init() {
    this.joinPubKey = secp256k1.publicKeyCreate(this.joinPrivKey, true);
    this.authPubKey = secp256k1.publicKeyCreate(this.authPrivKey, true);

    this.fingerPrint = getFingerprint(this.master);
    this.accountPrivKey = this.master.deriveAccount(44, this.purpose, 0);
    this.accountKey = this.accountPrivKey.toPublic();
  }

  toJSON() {
    return {
      name: this.name,
      walletName: this.walletName,
      token: this.token.toString('hex'),
      data: this.data.toString('hex'),
      network: this.network.toString(),
      master: this.master.xprivkey(this.network),
      joinPrivKey: this.joinPrivKey.toString('hex'),
      authPrivKey: this.authPrivKey.toString('hex'),
      fingerPrint: this.fingerPrint
    };
  }

  fromJSON(json) {
    this.name = json.name;
    this.walletName = json.walletName;
    this.token = Buffer.from(json.token, 'hex');
    this.data = Buffer.from(json.data, 'hex');
    this.network = Network.get(json.network);
    this.master = hd.PrivateKey.fromBase58(json.master, this.network);
    this.joinPrivKey = Buffer.from(json.joinPrivKey, 'hex');
    this.authPrivKey = Buffer.from(json.authPrivKey, 'hex');
    this.fingerPrint = json.fingerPrint;

    this.init();

    return this;
  }

  get xpub() {
    return this.accountKey.xpubkey(this.network);
  }

  get joinHash() {
    if (!this._joinHash) {
      assert(this.joinPrivKey != null);
      assert(this.accountKey);
      assert(this.name !== '');
      assert(this.walletName !== '');
      assert(this.authPubKey != null);

      this._joinHash = sigUtils.getJoinHash(this.walletName, {
        name: this.name,
        authPubKey: this.authPubKey,
        key: this.accountKey
      }, this.network);
    }

    return this._joinHash;
  }

  get joinSignature() {
    if (this._joinSignature == null) {
      assert(this.joinPrivKey != null);
      assert(this.accountKey);
      assert(this.name !== '');
      assert(this.walletName !== '');
      assert(this.authPubKey != null);

      const hash = this.joinHash;

      this._joinSignature = sigUtils.signHash(hash, this.joinPrivKey);
    }

    return this._joinSignature;
  }

  get xpubProof() {
    if (this._xpubProof == null) {
      assert(this.joinPrivKey != null);
      assert(this.accountKey);
      assert(this.name !== '');
      assert(this.walletName !== '');
      assert(this.authPubKey != null);

      const hash = this.joinHash;
      const proofHDPrivKey = this.accountPrivKey
        .derive(sigUtils.PROOF_INDEX)
        .derive(0);

      const proofPrivKey = proofHDPrivKey.privateKey;

      this._xpubProof = sigUtils.signHash(hash, proofPrivKey);
    }

    return this._xpubProof;
  }

  /**
   * @param {ProposalPayloadType} type
   * @param {Object|String} options
   * @returns {Buffer} signature
   */

  signProposal(type, options) {
    if (typeof options === 'object')
      options = JSON.stringify(options);

    assert((type & 0xff) === type);
    assert(typeof options === 'string');
    const hash = sigUtils.getProposalHash(this.walletName, type, options);

    const signature = sigUtils.signHash(hash, this.authPrivKey);

    return signature;
  }

  /**
   * @returns {Cosigner}
   */

  toCosigner() {
    if (!this._cosigner) {
      this._cosigner = Cosigner.fromOptions({
        name: this.name,
        key: this.accountKey,
        authPubKey: this.authPubKey,
        joinSignature: this.joinSignature,
        fingerPrint: this.fingerPrint,
        token: this.token,
        purpose: this.purpose
      });
    }

    return this._cosigner;
  }

  toHTTPOptions() {
    return {
      cosigner: {
        name: this.name,
        purpose: this.purpose,
        fingerPrint: this.fingerPrint,
        data: this.data.toString('hex'),
        token: this.token.toString('hex'),
        accountKey: this.xpub,
        accountKeyProof: this.xpubProof.toString('hex'),
        authPubKey: this.authPubKey.toString('hex')
      },
      joinSignature: this.joinSignature.toString('hex')
    };
  }

  [custom]() {
    return '<CosignerContext\n'
      + `  name=${this.name}\n`
      + `  walletName=${this.walletName}\n`
      + `  network=${this.network.type}\n`
      + `  master=${this.master.xprivkey(this.network)} \n`
      + `  token=${this.token.toString('hex')} \n`
      + `  fingerPrint=${this.fingerPrint}\n`
      + `  purpose=${this.purpose}\n`
      + `  xpub=${this.xpub}\n`
      + `  authPubKey=${this.authPubKey.toString('hex')}\n`
      + `  joinPubKey=${this.joinPubKey.toString('hex')}\n`
      + `  cosigner=${util.inspect(this.cosigner)}`
      + '/>';
  }

  refresh() {
    this._cosigner = null;
    this._xpubProof = null;
    this._joinSignature = null;
    this._joinHash = null;
  }

  static fromOptions(options) {
    return new this(options);
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }
}

function getFingerprint(master) {
  const fp = hash160.digest(master.publicKey);
  return fp.readUInt32BE(0, true);
}

module.exports = CosignerContext;
