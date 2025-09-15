import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
// --- تعریف اینترفیس‌ها برای Type-Safety ---

export interface NetworkConfig {
    id: string;
    name: string;
    networkType: string;
    chainId: number;
    currencySymbol: string;
    rpcUrls: string[];
    phoenixContractAddress:string
    decimals:number
    derivationPath:string
    explorers:string[]
    iconUrl:string
    // ... سایر فیلدهای فایل networks.json
}

interface AssetConfig {
    id: string;
    symbol: string;
    networkId: string;
    // ... سایر فیلدهای فایل assets.json
}

export class BlockchainRegistry {
    private networksById: Map<string, NetworkConfig> = new Map();
    private networksByChainId: Map<number, NetworkConfig> = new Map();

    // این Map به ما می‌گوید که یک نماد ارز (مثل 'ETH') روی چه شبکه‌هایی موجود است
    private networksByAssetSymbol: Map<string, NetworkConfig[]> = new Map();

    constructor() {
        this.loadNetworksFromFile();
        this.loadAssetsFromFile(); // دارایی‌ها را هم بارگذاری می‌کنیم
    }

    /**
     * فایل networks.json را از ریشه پروژه خوانده و داده‌های آن را در حافظه بارگذاری می‌کند.
     */
    private loadNetworksFromFile(filePath: string = 'networks.json') {
        try {
            const fullPath = path.join(process.cwd(), filePath);
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const networkConfigs: NetworkConfig[] = JSON.parse(fileContent);

            networkConfigs.forEach(config => {
                this.networksById.set(config.id, config);
                if (config.chainId) {
                    this.networksByChainId.set(config.chainId, config);
                }

                // هر شبکه، توکن اصلی خودش را پشتیبانی می‌کند
                const nativeSymbol = config.currencySymbol.toUpperCase();
                if (!this.networksByAssetSymbol.has(nativeSymbol)) {
                    this.networksByAssetSymbol.set(nativeSymbol, []);
                }
                this.networksByAssetSymbol.get(nativeSymbol)!.push(config);
            });
            console.log('✅ Blockchain networks loaded successfully.');
        } catch (error) {
            console.error('❌ Failed to load or parse networks.json:', error);
            throw new Error('Could not initialize BlockchainRegistry from file.');
        }
    }

    /**
     * فایل assets.json را می‌خواند تا بفهمد کدام توکن‌های قراردادی روی کدام شبکه‌ها هستند.
     */
    private loadAssetsFromFile(filePath: string = 'assets.json') {
        try {
            const fullPath = path.join(process.cwd(), filePath);
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const assetConfigs: AssetConfig[] = JSON.parse(fileContent);

            assetConfigs.forEach(asset => {
                const network = this.networksById.get(asset.networkId);
                if (network) {
                    const assetSymbol = asset.symbol.toUpperCase();

                    // اگر کلیدی برای این نماد وجود ندارد، یک آرایه خالی برای آن بساز
                    if (!this.networksByAssetSymbol.has(assetSymbol)) {
                        this.networksByAssetSymbol.set(assetSymbol, []);
                    }

                    // لیست شبکه‌های موجود برای این نماد را بگیر
                    const existingNetworks = this.networksByAssetSymbol.get(assetSymbol)!;

                    // فقط در صورتی شبکه جدید را اضافه کن که قبلاً در لیست وجود نداشته باشد
                    // این کار از اضافه شدن تکراری (مثلاً اگر ETH هم به عنوان توکن اصلی و هم در assets.json باشد) جلوگیری می‌کند.
                    if (!existingNetworks.some(n => n.id === network.id)) {
                        existingNetworks.push(network);
                    }
                }
            });
            console.log('✅ Asset configurations loaded and mapped successfully.');
        } catch (error) {
            console.error('❌ Failed to load or parse assets.json:', error);
        }
    }

    /**
     * یک شبکه را با شناسه (id) آن پیدا می‌کند.
     * @param id شناسه شبکه (e.g., "sepolia")
     */
    public getNetworkById(id: string): NetworkConfig | undefined {
        return this.networksById.get(id);
    }

    /**
     * یک شبکه را با شناسه زنجیره (Chain ID) آن پیدا می‌کند.
     * @param chainId شناسه زنجیره (e.g., 11155111)
     */
    public getNetworkByChainId(chainId: number): NetworkConfig | undefined {
        return this.networksByChainId.get(chainId);
    }

    public getBitcoinNetwork(isTestnet: boolean): NetworkConfig | undefined {
        const targetId = isTestnet ? 'bitcoin_testnet' : 'bitcoin_mainnet';
        return this.getNetworkById(targetId);
    }


    /**
     * یک JsonRpcProvider با تنظیمات بهینه (بدون batching) برای یک شبکه خاص می‌سازد.
     */
    public getProvider(chainId: number): ethers.JsonRpcProvider {
        const network = this.getNetworkByChainId(chainId);
        if (!network || !network.rpcUrls[0]) {
            throw new Error(`RPC URL for chainId ${chainId} not found in registry.`);
        }

        const providerOptions = {
            batchMaxCount: 1, // <<<--- تنظیمات کلیدی
        };

        // در اینجا می‌توانیم یک کش هم اضافه کنیم تا از ساخت مکرر provider جلوگیری شود.
        return new ethers.JsonRpcProvider(network.rpcUrls[0], undefined, providerOptions);
    }
}