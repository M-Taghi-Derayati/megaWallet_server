import * as bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import {Buffer} from "buffer";

const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc); // ضروری
//m/84'/1'/0'/1 //child
//m/84'/1'/0'/0 //parent
// ۱. یک mnemonic جدید بسازید (یا mnemonic خودتان را اینجا قرار دهید)
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"; // <<-- از یک mnemonic تستی استفاده کنید
console.log("Mnemonic:", mnemonic);

// ۲. mnemonic را به seed تبدیل کنید
const seed = bip39.mnemonicToSeedSync(mnemonic);

// ۳. یک master node (root) از seed بسازید (برای testnet)
const root = bip32.fromSeed(seed, bitcoin.networks.testnet);

// ۴. کلید "Account" را برای مسیر BIP84 تست‌نت استخراج کنید
// مسیر صحیح حساب: m / purpose' / coin_type' / account'
const accountPath = "m/84'/1'/0'"; // <<-- مسیر تا سطح Account
const accountNode = root.derivePath(accountPath);

// ۵. کلید خصوصی گسترش‌ یافته (tprv) را برای "حساب" بگیرید
const tprv = accountNode.toBase58(); // <<<--- این کلید صحیح است
console.log("Account Derivation Path:", accountPath);
console.log("Account Extended Private Key (tprv):", tprv);

// --- تست و تأیید ---
console.log("\n--- Verification ---");
// حالا اولین آدرس دریافت (0/0) را از این accountNode مشتق می‌کنیم
const firstReceiveNode = accountNode.derive(0).derive(0);
const { address } = bitcoin.payments.p2wpkh({
    pubkey:Buffer.from(firstReceiveNode.publicKey),
    network: bitcoin.networks.testnet
});
console.log("First Receiving Address (path 0/0):", address);