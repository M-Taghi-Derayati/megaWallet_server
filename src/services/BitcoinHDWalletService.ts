import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory, BIP32Interface } from 'bip32';
import { BlockchainRegistry, NetworkConfig } from '../config/BlockchainRegistry';
import { PrismaClient } from '@prisma/client';
import { Buffer } from 'buffer';
import bs58check from "bs58check";
// تزریق وابستگی برای کتابخانه رمزنگاری
const bip32 = BIP32Factory(ecc);
const prisma = new PrismaClient();

// اینترفیس برای خروجی تابع جهت خوانایی بهتر
export interface NewAddressResult {
    address: string;
    path: string;
    index: number;
}

export class BitcoinHDWalletService {
    private masterNode: BIP32Interface;
    private network: bitcoin.Network;
    private networkConfig: NetworkConfig; // اطلاعات کامل شبکه از registry
    private nextAddressIndex: number = 0;
    private walletId: string; // شناسه منحصر به فرد برای این کیف پول در دیتابیس

    constructor(registry: BlockchainRegistry) {
        const xprv = process.env.BITCOIN_MASTER_XPRV;
        if (!xprv) {
            throw new Error("BITCOIN_MASTER_XPRV is not defined in the .env file.");
        }

        const isTestnet = xprv.startsWith('tprv');

        this.network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.testnet;

        // پیدا کردن کانفیگ شبکه صحیح از رجیستری
        const networkConfig = registry.getBitcoinNetwork(isTestnet);
        if (!networkConfig) {
            const networkName = isTestnet ? 'Testnet' : 'Mainnet';
            throw new Error(`Bitcoin ${networkName} configuration not found in networks.json.`);
        }
        this.networkConfig = networkConfig;
        this.walletId = this.networkConfig.id; // e.g., "bitcoin_testnet"
        console.log(`[BitcoinHDWallet] Initializing for ${this.networkConfig.name}...`);
        this.masterNode = bip32.fromBase58(xprv, this.network);

        // بارگذاری آخرین ایندکس از دیتابیس در زمان شروع
        this.loadNextAddressIndexFromDB();
    }

    /**
     * به صورت آسنکرون، آخرین ایندکس استفاده شده را از دیتابیس می‌خواند.
     */
    private async loadNextAddressIndexFromDB(): Promise<void> {
        try {
            const state = await prisma.hdWalletState.findUnique({
                where: { id: this.walletId }
            });
            if (state) {
                this.nextAddressIndex = state.nextIndex;
                console.log(`[BitcoinHDWallet] Resumed address index from DB: ${this.nextAddressIndex}`);
            } else {
                // اگر حالتی وجود نداشت، یک رکورد جدید با ایندکس 0 ایجاد می‌کنیم
                await prisma.hdWalletState.create({
                    data: { id: this.walletId, nextIndex: 0 }
                });
                console.log(`[BitcoinHDWallet] Initialized new wallet state in DB with index 0.`);
            }
        } catch (error) {
            console.error("❌ Failed to load HD wallet state from DB:", error);
            // در صورت خطا، برنامه را متوقف می‌کنیم تا از تولید آدرس تکراری جلوگیری شود
            throw new Error("Database error while loading wallet state.");
        }
    }

    /**
     * ایندکس جدید را در دیتابیس ذخیره می‌کند.
     */
    private async saveNextAddressIndexToDB(index: number): Promise<void> {
        await prisma.hdWalletState.upsert({
            where: { id: this.walletId },
            update: { nextIndex: index },
            create: { id: this.walletId, nextIndex: index },
        });
    }

    /**
     * یک آدرس دریافت جدید و استفاده نشده تولید کرده و وضعیت را در دیتابیس آپدیت می‌کند.
     */
    public async getNewAddress(): Promise<NewAddressResult> {
        // مسیر استخراج را از کانفیگ خوانده و ایندکس را جایگزین می‌کنیم
        const relativePath = this.networkConfig.derivationPath.replace('{index}', this.nextAddressIndex.toString());
        const childNode = this.masterNode.derivePath(relativePath);
        const fullPath = `m/84'/1'/0'/${relativePath}`;

        // TODO: این بخش باید بر اساس نوع derivationPath (BIP84, BIP49, ...) هوشمندتر شود
        // فعلاً فرض بر BIP84 (Native SegWit) است که رایج‌ترین حالت است
        const { address } = bitcoin.payments.p2wpkh({
            // childNode.publicKey یک Uint8Array است. ما آن را به Buffer تبدیل می‌کنیم.
            pubkey: Buffer.from(childNode.publicKey),
            network: this.network,
        });

        if (!address) {
            throw new Error("Failed to generate a valid Bitcoin address.");
        }

        const result: NewAddressResult = {
            address: address,
            path: fullPath,
            index: this.nextAddressIndex,
        };

        // ایندکس را برای دفعه بعد افزایش داده و در دیتابیس ذخیره می‌کنیم
        const newIndex = this.nextAddressIndex + 1;
        await this.saveNextAddressIndexToDB(newIndex);
        this.nextAddressIndex = newIndex;

        console.log(`[BitcoinHDWallet] Generated new address: ${address} at path ${relativePath}`);
        return result;
    }

    private convertExtendedKey(key: string, targetVersion: Buffer) {
        const data = bs58check.decode(key);
        // جایگزین کردن 4 بایت ابتدایی (version bytes)
        targetVersion.copy(data, 0);
        return bs58check.encode(data);
    }
}