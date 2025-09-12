import { ethers, Wallet, Contract } from 'ethers';
import { BlockchainRegistry } from '../config/BlockchainRegistry';
import Erc20Abi from '../abi/Erc20.json';
import {AssetRegistry} from "../config/AssetRegistry"; // ما به یک ABI استاندارد ERC20 نیاز داریم

export class PayoutService {
    private registry: BlockchainRegistry;
    private assetRegistry: AssetRegistry; // برای پیدا کردن آدرس قرارداد توکن‌ها

    constructor(registry: BlockchainRegistry, assetRegistry: AssetRegistry) {
        this.registry = registry;
        this.assetRegistry = assetRegistry;
    }

    /**
     * کیف پول پرداخت (Payout Wallet) را برای یک شبکه خاص می‌سازد.
     * این کیف پول باید از قبل شارژ شده باشد.
     */
    private getPayoutWallet(chainId: number): Wallet {
        const network = this.registry.getNetworkByChainId(chainId);
        if (!network) {
            throw new Error(`[Payout] Network configuration for chainId ${chainId} not found.`);
        }

        // نام متغیر کلید خصوصی را به صورت داینامیک می‌سازیم (e.g., SEPOLIA_PAYOUT_WALLET_PRIVATE_KEY)
        const privateKeyEnvVar = `${network.name.toUpperCase()}_PAYOUT_WALLET_PRIVATE_KEY`;
        const privateKey = process.env[privateKeyEnvVar];

        if (!privateKey) {
            throw new Error(`[Payout] Payout wallet private key for ${network.name} is not configured in .env`);
        }

        const provider = new ethers.JsonRpcProvider(network.rpcUrls[0]);
        return new Wallet(privateKey, provider);
    }

    /**
     * یک مقدار از توکن اصلی شبکه (مانند ETH, tBNB, MATIC) را به یک آدرس ارسال می‌کند.
     *
     * @param chainId شناسه زنجیره شبکه مقصد.
     * @param recipientAddress آدرس گیرنده.
     * @param amountToDoSend مقدار ارسالی به صورت رشته (e.g., "0.01").
     * @returns هش تراکنش در صورت موفقیت.
     */
    public async sendNativeToken(
        chainId: number,
        recipientAddress: string,
        amountToSend: string
    ): Promise<string> {
        const wallet = this.getPayoutWallet(chainId);
        // parseUnits برای تبدیل ایمن به کوچکترین واحد استفاده می‌شود
        const network = this.registry.getNetworkByChainId(chainId)!;
        const amountInWei = ethers.parseUnits(amountToSend, network.decimals);

        console.log(`[PAYOUT] Sending ${amountToSend} ${network.currencySymbol} from ${wallet.address} to ${recipientAddress}...`);

        try {
            const tx = await wallet.sendTransaction({
                to: recipientAddress,
                value: amountInWei
            });

            console.log(`[PAYOUT] Native token transfer sent. Hash: ${tx.hash}. Waiting for confirmation...`);
            await tx.wait(1);
            console.log(`[PAYOUT] ✅ Native token transfer successful.`);
            return tx.hash;

        } catch (error: any) {
            console.error(`[PAYOUT] ❌ Failed to send native token:`, error.message);
            throw new Error(`Payout transfer failed: ${error.reason || error.message}`);
        }
    }

    /**
     * یک مقدار از یک توکن قراردادی ERC20 (مانند USDT) را به یک آدرس ارسال می‌کند.
     *
     * @param chainId شناسه زنجیره شبکه مقصد.
     * @param tokenSymbol نماد توکن (e.g., "USDT").
     * @param recipientAddress آدرس گیرنده.
     * @param amountToSend مقدار ارسالی به صورت رشته (e.g., "10.5").
     * @returns هش تراکنش در صورت موفقیت.
     */
    public async sendErc20Token(
        chainId: number,
        tokenSymbol: string,
        recipientAddress: string,
        amountToSend: string
    ): Promise<string> {
        const wallet = this.getPayoutWallet(chainId);
        const network = this.registry.getNetworkByChainId(chainId)!;

        // پیدا کردن اطلاعات توکن از AssetRegistry
        const assetConfig = this.assetRegistry.getAssetBySymbol(tokenSymbol, network.id);
        if (!assetConfig || !assetConfig.contractAddress) {
            throw new Error(`[Payout] Asset ${tokenSymbol} or its contract address not found on network ${network.id}.`);
        }

        const tokenContract = new Contract(assetConfig.contractAddress, Erc20Abi, wallet);
        const amountInSmallestUnit = ethers.parseUnits(amountToSend, assetConfig.decimals);

        console.log(`[PAYOUT] Sending ${amountToSend} ${tokenSymbol} from ${wallet.address} to ${recipientAddress}...`);

        try {
            const tx = await tokenContract.transfer(recipientAddress, amountInSmallestUnit);

            console.log(`[PAYOUT] ERC20 token transfer sent. Hash: ${tx.hash}. Waiting for confirmation...`);
            await tx.wait(1);
            console.log(`[PAYOUT] ✅ ERC20 token transfer successful.`);
            return tx.hash;

        } catch (error: any) {
            console.error(`[PAYOUT] ❌ Failed to send ERC20 token:`, error.message);
            throw new Error(`Payout transfer failed: ${error.reason || error.message}`);
        }
    }
}