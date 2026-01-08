import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import fs from 'fs';
import { loadEncryptedSecretKeys } from './loadEncryptedSecretKeys.js';
import { swap as jupiterSwap } from './jupiter-swap.js';
import { swap as raydiumSwap, getQuote as raydiumGetQuote } from './clients/raydium-swap.js';
import axios from 'axios';

dotenv.config();
await loadEncryptedSecretKeys(); // decrypt secret keys into memory

const LAMPORTS_BUFFER = 0.01 * 1e9; //This is how much SOL should stay in wallet for gas fees
// Load config.json
const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
const DEFAULT_TOKEN_ADDRESS = 'znv3FZt2HFAvzYf5LxzVyryh3mBXWuTRRng25gEZAjh';
const WRAPPED_SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
// Create Solana RPC connection
const connection = new Connection(config.rpcUrl || "https://api.mainnet-beta.solana.com", "confirmed");
const SOLANA_DELAY_IN_MS = 10000;

// Load all wallet private keys
const secretKeys = JSON.parse(process.env.SECRET_KEYS);
const delayInMinutes = config.delayInMinutes || 2.5;

export function loadWallets(){
    const configMap = new Map(config.wallets.map(w => [w.walletAddress, w]));
    return secretKeys.map(privateKey => {
        const keyPair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const publicKey = keyPair.publicKey.toBase58();
        const config = configMap.get(publicKey) || {name: 'New Wallet', tokenAddress: DEFAULT_TOKEN_ADDRESS};
        return {
            walletKeyPair: keyPair,
            name: config.name,
            tokenAddress: config.tokenAddress
        }
    });
    

}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function formatSOL(lamports) {
    return (lamports / 1e9).toFixed(9).replace(/\.?0+$/, '');
}

function formatToken(amount, decimals = 6) {
    return (amount / Math.pow(10, decimals)).toLocaleString('en-US', {
        maximumFractionDigits: decimals,
        minimumFractionDigits: 0
    });
}

async function main() {
    const wallets = loadWallets();
    console.log(`\n🚀 Monitoring ${wallets.length} wallet(s) for incoming SOL...\n`);

    while (true) {
        console.log("🔀 Shuffling wallet order...");
        shuffleArray(wallets);
        wallets.forEach(element => {
            const shortAddress = `${element.walletKeyPair.publicKey.toBase58().slice(0, 4)}...${element.walletKeyPair.publicKey.toBase58().slice(-4)}`;
            const shortToken = `${element.tokenAddress.slice(0, 4)}...${element.tokenAddress.slice(-4)}`;
            console.log(`  💼 ${element.name} (${shortAddress}) → ${shortToken}`);
        });
        console.log();

        for (let i = 0; i < wallets.length; i++){
            const walletConfig = wallets[i];
            await autoBuyToken(walletConfig);
        }

        console.log(`\n⏳ All wallets processed. Waiting ${delayInMinutes} minutes...\n`);
        await sleep(delayInMinutes * 60 * 1000); 
    }
}

/**
 * Get quote from Jupiter
 */
async function getJupiterQuote(inputMint, outputMint, lamports) {
    try {
        const response = await axios.get(`https://api.jup.ag/swap/v1/quote`, {
            params: {
                inputMint,
                outputMint,
                amount: lamports.toString(),
                slippageBps: 50
            },
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        if (!response.data || !response.data.outAmount) {
            throw new Error('Invalid Jupiter quote response');
        }
        
        return {
            outAmount: BigInt(response.data.outAmount),
            provider: 'jupiter',
            priceImpact: response.data.priceImpactPct ? parseFloat(response.data.priceImpactPct) : 0
        };
    } catch (error) {
        if (error.response?.status === 401) {
            throw new Error('Jupiter API requires authentication');
        }
        throw new Error(`Jupiter quote failed: ${error.message}`);
    }
}

/**
 * Compare quotes and return the best one
 */
async function getBestQuote(connection, inputMint, outputMint, lamports) {
    const quotes = [];
    
    // Get Jupiter quote (aggregator - checks multiple DEXs)
    try {
        const jupiterQuote = await getJupiterQuote(inputMint, outputMint, lamports);
        quotes.push(jupiterQuote);
        console.log(`  💱 Jupiter quote: ${formatToken(jupiterQuote.outAmount.toString(), 6)} tokens`);
    } catch (error) {
        console.log(`  ⚠️  Jupiter quote unavailable: ${error.message}`);
    }
    
    // Get Raydium quote (direct DEX)
    // Note: Raydium's API automatically routes through the best available pool
    // It checks all pools for the token pair and uses optimal routing
    try {
        const raydiumQuote = await raydiumGetQuote(connection, inputMint, outputMint, lamports);
        quotes.push(raydiumQuote);
        const priceImpact = raydiumQuote.priceImpact ? (raydiumQuote.priceImpact * 100).toFixed(2) : 'N/A';
        const swapType = raydiumQuote.swapType || 'auto-routed';
        console.log(`  💱 Raydium quote: ${formatToken(raydiumQuote.outAmount.toString(), 6)} tokens (${swapType}, ${priceImpact}% impact)`);
        console.log(`     ℹ️  Raydium automatically routes through the best pool for optimal price`);
    } catch (error) {
        console.log(`  ⚠️  Raydium quote unavailable: ${error.message}`);
    }
    
    if (quotes.length === 0) {
        throw new Error('No quotes available from any provider');
    }
    
    // Find the best quote (highest output amount)
    const bestQuote = quotes.reduce((best, current) => 
        current.outAmount > best.outAmount ? current : best
    );
    
    const improvement = quotes.length > 1 
        ? ((Number(bestQuote.outAmount) - Number(quotes.find(q => q.provider !== bestQuote.provider)?.outAmount || 0)) / Number(quotes.find(q => q.provider !== bestQuote.provider)?.outAmount || 1) * 100).toFixed(2)
        : 0;
    
    if (quotes.length > 1 && improvement > 0) {
        console.log(`  🏆 Best price: ${bestQuote.provider.toUpperCase()} (+${improvement}% better)`);
    } else {
        console.log(`  🏆 Using: ${bestQuote.provider.toUpperCase()}`);
    }
    
    return bestQuote;
}

async function autoBuyToken(walletConfig) {
    const solanaLamports = await connection.getBalance(walletConfig.walletKeyPair.publicKey);
    const totalSOL = formatSOL(solanaLamports);
    const bufferSOL = formatSOL(LAMPORTS_BUFFER);
    
    if (solanaLamports >= LAMPORTS_BUFFER * 2) {
        const solAmount = solanaLamports - LAMPORTS_BUFFER;
        const swapSOL = formatSOL(solAmount);
        const shortToken = `${walletConfig.tokenAddress.slice(0, 4)}...${walletConfig.tokenAddress.slice(-4)}`;
        
        console.log(`\n💰 ${walletConfig.name}`);
        console.log(`  Balance: ${totalSOL} SOL (keeping ${bufferSOL} SOL for fees)`);
        console.log(`  Swapping: ${swapSOL} SOL → ${shortToken}`);
        
        try {
            // Get best quote from all available providers
            const bestQuote = await getBestQuote(connection, WRAPPED_SOL_MINT_ADDRESS, walletConfig.tokenAddress, solAmount);
            
            // Execute swap with the best provider
            const swapFunction = bestQuote.provider === 'jupiter' ? jupiterSwap : raydiumSwap;
            const quoteResponse = await swapFunction(connection, walletConfig.walletKeyPair, WRAPPED_SOL_MINT_ADDRESS, walletConfig.tokenAddress, solAmount);
            
            const tokenAmount = formatToken(quoteResponse.outAmount, 6);
            console.log(`  ✅ Successfully swapped ${swapSOL} SOL for ${tokenAmount} tokens via ${bestQuote.provider.toUpperCase()}`);
        } catch (error) {
            console.error(`  ❌ Swap failed: ${error.message}`);
        }
        await sleep(SOLANA_DELAY_IN_MS);
    } else {
        const shortAddress = `${walletConfig.walletKeyPair.publicKey.toBase58().slice(0, 4)}...${walletConfig.walletKeyPair.publicKey.toBase58().slice(-4)}`;
        console.log(`  ⏭️  ${walletConfig.name} (${shortAddress}): Insufficient balance (${totalSOL} SOL < ${bufferSOL} SOL buffer)`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
