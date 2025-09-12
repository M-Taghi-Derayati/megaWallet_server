import * as fs from 'fs';
import * as path from 'path';

// --- تعریف اینترفیس برای ساختار داده دارایی ---
// این باید با ساختار آبجکت‌ها در assets.json مطابقت داشته باشد
export interface AssetConfig {
    id: string;
    name: string;
    symbol: string;
    decimals: number;
    networkId: string;
    contractAddress: string | null; // می‌تواند null باشد برای توکن‌های اصلی
    coinGeckoId: string | null;
    iconUrl: string | null;
}

export class AssetRegistry {
    private assetsById: Map<string, AssetConfig> = new Map();
    private assetsBySymbolAndNetwork: Map<string, AssetConfig> = new Map();
    private assetsBySymbol: Map<string, AssetConfig[]> = new Map();

    constructor() {
        this.loadAssetsFromFile();
    }

    /**
     * فایل assets.json را از ریشه پروژه خوانده و داده‌های آن را در حافظه بارگذاری می‌کند.
     */
    private loadAssetsFromFile(filePath: string = 'assets.json') {
        try {
            const fullPath = path.join(process.cwd(), filePath);
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const assetConfigs: AssetConfig[] = JSON.parse(fileContent);

            assetConfigs.forEach(config => {
                // ذخیره بر اساس ID کامل (e.g., "USDT-SEPOLIA")
                this.assetsById.set(config.id, config);
                const symbol = config.symbol.toUpperCase();
                if (!this.assetsBySymbol.has(symbol)) {
                    this.assetsBySymbol.set(symbol, []);
                }
                this.assetsBySymbol.get(symbol)!.push(config);

                // ذخیره بر اساس کلید ترکیبی "SYMBOL@NETWORK_ID" برای جستجوی سریع
                const compositeKey = `${config.symbol.toUpperCase()}@${config.networkId}`;
                this.assetsBySymbolAndNetwork.set(compositeKey, config);
            });
            console.log('✅ Asset configurations loaded successfully.');
        } catch (error) {
            console.error('❌ Failed to load or parse assets.json:', error);
            throw new Error('Could not initialize AssetRegistry from file.');
        }
    }

    /**
     * یک دارایی را با ID کامل آن پیدا می‌کند.
     * @param id شناسه کامل دارایی (e.g., "USDT-SEPOLIA")
     */
    public getAssetById(id: string): AssetConfig | undefined {
        return this.assetsById.get(id);
    }

    /**
     * یک دارایی خاص را با نماد و شناسه شبکه آن پیدا می‌کند.
     * این متد برای پیدا کردن اطلاعات دقیق یک توکن (مثل آدرس قرارداد) در یک شبکه خاص بسیار مفید است.
     * @param symbol نماد ارز (e.g., "USDT")
     * @param networkId شناسه شبکه (e.g., "sepolia")
     */
    public getAssetBySymbol(symbol: string, networkId: string): AssetConfig | undefined {
        const compositeKey = `${symbol.toUpperCase()}@${networkId}`;
        return this.assetsBySymbolAndNetwork.get(compositeKey);
    }

    public getAssetDeployments(symbol: string): AssetConfig[] {
        return this.assetsBySymbol.get(symbol.toUpperCase()) || [];
    }

    /**
     * تمام دارایی‌های پشتیبانی شده را برمی‌گرداند.
     */
    public getAllAssets(): AssetConfig[] {
        return Array.from(this.assetsById.values());
    }
}