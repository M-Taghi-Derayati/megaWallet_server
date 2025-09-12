import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import {Buffer} from "buffer";

// تزریق وابستگی‌ها
const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc); // <<-- این خط برای نسخه‌های جدید bitcoinjs-lib ضروری است

// --- اطلاعات ورودی ---
const TPRV = "tprv8fYaAGJ1xMysWhkyaqPyeKj49JbF7hXK9iisPpQBUnS1LYPAbmBHKb9Q7fDKHeHSPYpHfjhijwQ56zR8kMghbDSPPk3HykQVbvaUhm5uXwD";
const TARGET_ADDRESS = "tb1q8svefdyfeqqah0jts3twx2lq3ehhgkwk6kazvq";
const ADDRESSES_TO_SCAN = 20; // چند آدرس را اسکن کنیم
// --------------------

async function findAddress() {
    console.log("--- Bitcoin Address Finder ---");
    console.log("Searching for address:", TARGET_ADDRESS);

    try {
        const network = bitcoin.networks.testnet;
        const accountNode = bip32.fromBase58(TPRV, network);

        console.log("\nDeriving RECEIVING addresses (path 0/i)...");
        for (let i = 0; i < ADDRESSES_TO_SCAN; i++) {
            const path = `0/${i}`;
            const childNode = accountNode.derivePath(path);
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: Buffer.from(childNode.publicKey),
                network: network,
            });

            console.log(`Path: m/84'/1'/0'/${path}  =>  Address: ${address}`);
            if (address === TARGET_ADDRESS) {
                console.log(`\n✅✅✅ FOUND IT! ✅✅✅`);
                console.log(`Your address was found at receive index ${i}.`);
                return;
            }
        }

        console.log("\nDeriving CHANGE addresses (path 1/i)...");
        for (let i = 0; i < ADDRESSES_TO_SCAN; i++) {
            const path = `1/${i}`;
            const childNode = accountNode.derivePath(path);
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: Buffer.from(childNode.publicKey),
                network: network,
            });

            console.log(`Path: m/84'/1'/0'/${path}  =>  Address: ${address}`);
            if (address === TARGET_ADDRESS) {
                console.log(`\n✅✅✅ FOUND IT! ✅✅✅`);
                console.log(`Your address was found at CHANGE index ${i}.`);
                return;
            }
        }

        console.log(`\n❌❌❌ Address not found within the first ${ADDRESSES_TO_SCAN} receive/change addresses.`);

    } catch (error) {
        console.error("\nAn error occurred:", error);
    }
}

findAddress();