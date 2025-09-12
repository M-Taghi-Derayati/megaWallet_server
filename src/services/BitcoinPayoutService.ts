import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory, BIP32Interface } from 'bip32';
import axios from 'axios';
import { Buffer } from 'buffer';
import {BlockchainRegistry, NetworkConfig} from '../config/BlockchainRegistry';
import { ECPairFactory } from "ecpair";
import {Signer} from "bitcoinjs-lib/src/psbt";

const ECPair = ECPairFactory(ecc);

const bip32 = BIP32Factory(ecc);

interface Utxo {
    txid: string;
    vout: number;
    value: number; // in Satoshis
}

export class BitcoinPayoutService {
    private masterNode: BIP32Interface;
    private network: bitcoin.Network;
    private networkConfig: NetworkConfig;
    private registry: BlockchainRegistry;
    private explorerUrl: string;

    constructor(registry: BlockchainRegistry) {
        this.registry = registry;
        const xprv = process.env.BITCOIN_MASTER_XPRV;
        if (!xprv) throw new Error("BITCOIN_MASTER_XPRV is not configured.");

        const isTestnet = xprv.startsWith('tprv');
        this.network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.testnet;

        const networkConfig = this.registry.getBitcoinNetwork(isTestnet);
        if (!networkConfig || !networkConfig.explorers[0]) {
            throw new Error("Bitcoin network or explorer URL not configured.");
        }
        this.explorerUrl = networkConfig.explorers[0];
        this.networkConfig = networkConfig;
        this.masterNode = bip32.fromBase58(xprv, this.network);
    }


    public async sendBitcoin(recipientAddress: string, amountInBtc: number): Promise<string> {
        console.log(`[BTC Payout] Initiating REAL payout of ${amountInBtc} BTC to ${recipientAddress}`);
        const amountInSatoshi = Math.round(amountInBtc * 1e8);
        // ۱. مشخص کردن آدرس‌های خزانه
        const treasury = this.deriveAddressFromPath('0/0'); // آدرس اصلی پرداخت
        const changeAddress = this.deriveAddressFromPath('0/0'); // آدرس برای باقیمانده

        console.log(`[BTC Payout] Using Treasury Address: ${treasury.address}`);
        // --- ۱. دریافت منابع لازم ---
        // آدرس پرداخت اصلی ما (فرض می‌کنیم از اولین آدرس استفاده می‌کنیم)
        const availableUtxos = await this.fetchUtxos(treasury.address);
        if (availableUtxos.length === 0) {
            throw new Error("Payout wallet has no spendable UTXOs.");
        }
        const feeRate = await this.fetchFeeRate(); // sats/vB

        console.log(`[BTC Payout] Found ${availableUtxos.length} UTXOs. Current fee rate: ${feeRate} sats/vB.`);

        // --- ۲. انتخاب ورودی‌ها و محاسبه خروجی‌ها (Coin Selection) ---
        const psbt = new bitcoin.Psbt({ network: this.network });

        let totalInputSatoshi = 0;
        const inputsToSign: { index: number; keyPair: BIP32Interface; utxo: Utxo }[] = [];

        // الگوریتم ساده: اولین UTXO های کافی را انتخاب کن
        for (const utxo of availableUtxos) {
            const addressIndex = this.findIndexForUtxo(utxo); // در دمو، این همیشه 0 برمی‌گرداند
            const keyPair = this.deriveKeyPair(addressIndex);

            inputsToSign.push({ index: psbt.inputCount, keyPair, utxo });
            totalInputSatoshi += utxo.value;

            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: bitcoin.address.toOutputScript(treasury.address, this.network),
                    value: utxo.value,
                },
            });

            // چک می‌کنیم آیا موجودی برای پوشش مبلغ و کارمزد تخمینی کافی است یا نه
            const estimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
            if (totalInputSatoshi >= amountInSatoshi + estimatedFee) {
                break;
            }
        }

        // --- ۳. ساخت خروجی‌ها ---
        const finalEstimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
        if (totalInputSatoshi < amountInSatoshi + finalEstimatedFee) {
            throw new Error(`Insufficient funds. Required ~${amountInSatoshi + finalEstimatedFee} sats, but only have ${totalInputSatoshi} sats.`);
        }




        // خروجی برای گیرنده
        psbt.addOutput({
            address: recipientAddress,
            value: amountInSatoshi,
        });

        // خروجی باقیمانده (Change)
        const changeAmount = totalInputSatoshi - amountInSatoshi - finalEstimatedFee;
        if (changeAmount > 546) { // آستانه Dust (جلوگیری از ساخت خروجی‌های بسیار کوچک)
            psbt.addOutput({
                address: changeAddress.address,
                value: changeAmount,
            });
            console.log(`[BTC Payout] Change of ${changeAmount} sats will be sent to ${changeAddress.address}`);
        }

        // --- ۴. امضای هر ورودی به صورت جداگانه ---
        console.log(`[BTC Payout] Signing ${inputsToSign.length} transaction inputs...`);
        inputsToSign.forEach(input => {
            if (!input.keyPair.privateKey) {
                throw new Error(`Cannot sign input #${input.index}: Private key is missing.`);
            }
            const signer = ECPair.fromPrivateKey(input.keyPair.privateKey, { network: this.network });

            const fixedSigner: bitcoin.Signer = {
                publicKey: Buffer.from(signer.publicKey),
                sign: (hash: Buffer) => Buffer.from(signer.sign(hash)), // خروجی رو به Buffer تبدیل کردیم
            };

            psbt.signInput(input.index, fixedSigner);

        });

        // --- ۵. نهایی کردن و ارسال تراکنش ---
        psbt.finalizeAllInputs();
        const txHex = psbt.extractTransaction().toHex();

        console.log(`[BTC Payout] Broadcasting transaction... TxID: ${psbt.extractTransaction().getId()}`);
        return this.broadcastTx(txHex);
    }

   /* public async sendBitcoin(recipientAddress: string, amountInBtc: number): Promise<string> {
        console.log(`[BTC Payout] Initiating REAL payout of ${amountInBtc} BTC to ${recipientAddress}`);
        const amountInSatoshi = Math.round(amountInBtc * 1e8);

        // ۱. مشخص کردن آدرس‌های خزانه
        const treasury = this.deriveAddressFromPath('1/0'); // آدرس اصلی پرداخت
        const changeAddress = this.deriveAddressFromPath('1/1'); // آدرس برای باقیمانده

        console.log(`[BTC Payout] Using Treasury Address: ${treasury.address}`);

        // ۲. دریافت منابع لازم
        const availableUtxos = await this.fetchUtxos(treasury.address);
        if (availableUtxos.length === 0) {
            throw new Error("Treasury wallet has no spendable UTXOs.");
        }
        const feeRate = await this.fetchFeeRate();
        console.log(`[BTC Payout] Found ${availableUtxos.length} UTXOs. Current fee rate: ${feeRate} sats/vB.`);

        // ۳. ساخت تراکنش PSBT
        const psbt = new bitcoin.Psbt({ network: this.network });

        // ۴. انتخاب ورودی‌ها و اضافه کردن به PSBT
        const { inputs, totalInputSatoshi } = this.selectUtxos(availableUtxos, amountInSatoshi, feeRate);
        for (const utxo of inputs) {
            const txHex = await this.fetchTxHex(utxo.txid);
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: Buffer.from(txHex, 'hex'), // برای P2WPKH مهم است
            });
        }

        // ۵. ساخت خروجی‌ها
        const finalEstimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
        if (totalInputSatoshi < amountInSatoshi + finalEstimatedFee) {
            throw new Error(`Insufficient funds. Required ~${amountInSatoshi + finalEstimatedFee} sats, have ${totalInputSatoshi} sats.`);
        }

        psbt.addOutput({ address: recipientAddress, value: amountInSatoshi });
        const changeAmount = totalInputSatoshi - amountInSatoshi - finalEstimatedFee;
        if (changeAmount > 546) { // آستانه Dust
            psbt.addOutput({ address: changeAddress.address, value: Math.floor(changeAmount) });
            console.log(`[BTC Payout] Change of ${Math.floor(changeAmount)} sats will be sent to ${changeAddress.address}`);
        }

        // ۶. امضای تمام ورودی‌ها با کلید خزانه
        // چون تمام ورودی‌ها از یک آدرس (خزانه) هستند، می‌توانیم با یک کلید همه را امضا کنیم.
        const treasuryKeyPair = ECPair.fromPrivateKey(treasury.keyPair.privateKey!, { network: this.network });
        psbt.signAllInputs(treasuryKeyPair);

        // ۷. نهایی کردن و ارسال
        psbt.finalizeAllInputs();
        const tx = psbt.extractTransaction();
        console.log(`[BTC Payout] Broadcasting TxID: ${tx.getId()}`);
        return this.broadcastTx(tx.toHex());
    }*/

    // --- توابع کمکی ---
    private async fetchFeeRate(): Promise<number> {
        const url = new URL("v1/fees/recommended", this.explorerUrl).toString();
        const { data } = await axios.get(url);
        return data.halfHourFee; // استفاده از کارمزد نیم ساعته برای تعادل بین هزینه و سرعت
    }

    private estimateTxSize(inputCount: number, outputCount: number): number {
        // تخمین اندازه تراکنش P2WPKH
        const size = (inputCount * 68) + (outputCount * 31) + 11;
        return Math.ceil(size);
    }


    public async estimatePayoutFee(): Promise<{ feeSatoshi: number, feeBtc: number }> {
        const feeRate = await this.fetchFeeRate(); // دریافت نرخ لحظه‌ای (sats/vB)
        // فرض یک تراکنش استاندارد (۱ ورودی، ۲ خروجی)
        const estimatedSize = this.estimateTxSize(1, 2);

        const feeSatoshi = Math.ceil(estimatedSize * feeRate);
        const feeBtc = feeSatoshi / 1e8;

        return { feeSatoshi, feeBtc };
    }

    private async fetchTxHex(txid: string): Promise<string> {
        const { data } = await axios.get(`${this.explorerUrl}tx/${txid}/hex`);
        return data;
    }

    private async broadcastTx(txHex: string): Promise<string> {
        try {
            const { data } = await axios.post(`${this.explorerUrl}tx`, txHex, {
                headers: { 'Content-Type': 'text/plain' }
            });
            return data; // این باید TxID باشد
        } catch (error: any) {
            console.error("❌ Bitcoin broadcast failed:", error.response?.data || error.message);
            throw new Error(`Failed to broadcast Bitcoin transaction: ${error.response?.data}`);
        }
    }

    private deriveKeyPair(index: number): BIP32Interface {
        const relativePath = `0/${index}`; // فرض می‌کنیم آدرس‌های پرداخت هم در شاخه دریافت هستند
        return this.masterNode.derivePath(relativePath);
    }

    private deriveAddress(index: number): { address: string, keyPair: BIP32Interface } {
        const keyPair = this.deriveKeyPair(index);
        const { address } = bitcoin.payments.p2wpkh({
            pubkey:Buffer.from(keyPair.publicKey),
            network: this.network
        });
        if (!address) throw new Error("Could not derive address.");
        console.log("Main Address:    ", address)
        return { address, keyPair };
    }

    private findIndexForUtxo(utxo: Utxo): number {
        // نسخه ساده شده برای دمو: فرض می‌کنیم همه UTXO ها به آدرس اول ما تعلق دارند.
        // در یک سیستم واقعی، باید آدرس هر UTXO را با آدرس‌های مشتق شده مقایسه کنیم.
        return 0;
    }

    private deriveAddressFromPath(relativePath: string): { address: string, keyPair: BIP32Interface } {
        const keyPair = this.masterNode.derivePath(relativePath);
        const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network: this.network });
        if (!address) throw new Error(`Could not derive address for path ${relativePath}`);
        return { address, keyPair };
    }

    private async fetchUtxos(address: string): Promise<Utxo[]> {
        const { data } = await axios.get(`${this.explorerUrl}address/${address}/utxo`);
        return data;
    }

    /**
     * آدرس خزانه/پرداخت را برمی‌گرداند (اولین آدرس در شاخه باقیمانده).
     */
    private getTreasuryAddress(): { address: string; keyPair: BIP32Interface } {
        const changePath = `1/0`; // مسیر نسبی برای اولین آدرس باقیمانده
        const keyPair = this.masterNode.derivePath(changePath);
        const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network: this.network });
        return { address: address!, keyPair };
    }

    private selectUtxos(utxos: Utxo[], targetAmount: number, feeRate: number): { inputs: Utxo[], totalInputSatoshi: number } {
        // الگوریتم ساده: اولین UTXO هایی که مجموعشان کافی باشد را انتخاب کن
        let totalValue = 0;
        const selected = [];
        for (const utxo of utxos) {
            selected.push(utxo);
            totalValue += utxo.value;
            const estimatedFee = this.estimateTxSize(selected.length, 2) * feeRate;
            if (totalValue >= targetAmount + estimatedFee) break;
        }
        return { inputs: selected, totalInputSatoshi: totalValue };
    }

}