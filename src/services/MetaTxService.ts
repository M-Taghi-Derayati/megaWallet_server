import { ethers } from 'ethers';
import { BlockchainRegistry } from '../config/BlockchainRegistry';

// این ساختار باید با struct ForwardRequest در قرارداد MinimalForwarder مطابقت داشته باشد
export interface ForwardRequest {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    data: string;
}

export class MetaTxService {
    private registry: BlockchainRegistry;

    constructor(registry: BlockchainRegistry) {
        this.registry = registry;
    }

    /**
     * ساختار داده EIP-712 را برای یک ForwardRequest می‌سازد.
     * کلاینت (اندروید) از این ساختار برای تولید امضا استفاده می‌کند.
     */
    public async createForwardRequest(
        userAddress: string,
        chainId: number,
        quoteId: string,
        amountInWei: string
    ): Promise<{ request: ForwardRequest, domain: ethers.TypedDataDomain }> {

        const network = this.registry.getNetworkByChainId(chainId);
        if (!network || !network.phoenixContractAddress || !network.forwarderContractAddress) {
            throw new Error(`Configuration for chainId ${chainId} is incomplete.`);
        }

        const forwarderContract = new ethers.Contract(
            network.forwarderContractAddress,
            ['function getNonce(address from) public view returns (uint256)'],
            new ethers.JsonRpcProvider(network.rpcUrls[0])
        );

        const phoenixContract = new ethers.Contract(
            network.phoenixContractAddress,
            ['function executeNativeTrade(bytes32 quoteId)'], // فقط به اینترفیس این تابع نیاز داریم
            new ethers.JsonRpcProvider(network.rpcUrls[0])
        );

        // ۱. دریافت nonce فعلی کاربر از قرارداد Forwarder
        const nonce = (await forwarderContract.getNonce(userAddress)).toString();

        // ۲. انکود کردن داده‌های فراخوانی تابع (calldata)
        const quoteIdBytes32 = ethers.encodeBytes32String(quoteId.substring(0, 31));
        const calldata = phoenixContract.interface.encodeFunctionData("executeNativeTrade", [quoteIdBytes32]);

        // ۳. ساخت آبجکت ForwardRequest
        const request: ForwardRequest = {
            from: userAddress,
            to: network.phoenixContractAddress, // مقصد فراخوانی
            value: amountInWei, // مقدار ETH که باید همراه تراکنش ارسال شود
            gas: '300000', // یک gas limit امن و بالا
            nonce: nonce,
            data: calldata,
        };

        // ۴. ساخت EIP-712 Domain
        const domain: ethers.TypedDataDomain = {
            name: 'MinimalForwarder',
            version: '0.0.1',
            chainId: chainId,
            verifyingContract: network.forwarderContractAddress,
        };

        return { request, domain };
    }
}