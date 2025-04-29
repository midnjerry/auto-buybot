import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import fs from 'fs';
import { loadEncryptedSecretKeys } from './loadEncryptedSecretKeys.js';
import { swap } from './jupiter-swap.js';

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

async function main() {
    const wallets = loadWallets();
    console.log(`[+] Monitoring ${wallets.length} wallet(s) for incoming SOL...\n`);

    while (true) {
        console.log("Shuffling...");
        shuffleArray(wallets);
        wallets.forEach(element => {
            console.log(`Wallet [${element.name} - ${element.walletKeyPair.publicKey} Buy Target: ${element.tokenAddress}]`);
        });

        for (let i = 0; i < wallets.length; i++){
            const walletConfig = wallets[i];
            await autoBuyToken(walletConfig);
        }

        console.log(`All wallets processed. Waiting ${delayInMinutes} minutes...`);
        await sleep(delayInMinutes * 60 * 1000); 
    }
}

async function autoBuyToken(walletConfig) {
    const solanaLamports = await connection.getBalance(walletConfig.walletKeyPair.publicKey);
    if (solanaLamports >= LAMPORTS_BUFFER * 2) {
        const solAmount = solanaLamports - LAMPORTS_BUFFER;        
        console.log(`Attempting to buy ${walletConfig.tokenAddress} with ${solAmount / 1e9} $SOL`);
        const quoteResponse = await swap(connection, walletConfig.walletKeyPair, WRAPPED_SOL_MINT_ADDRESS, walletConfig.tokenAddress, solAmount);
        console.log(`Swapped ${solAmount} $SOL lamports for ${quoteResponse.outAmount} ${quoteResponse.outputSymbol} lamports`);
        await sleep(SOLANA_DELAY_IN_MS);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
