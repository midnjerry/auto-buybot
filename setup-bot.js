import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function isValidSecretKey(input) {
    try {
        if (input.startsWith('[')) {
            const arr = JSON.parse(input);
            if (!Array.isArray(arr) || arr.length !== 64) return false;
            Keypair.fromSecretKey(Uint8Array.from(arr));
            return true;
        } else {
            const decoded = bs58.decode(input);
            if (decoded.length !== 64) return false;
            Keypair.fromSecretKey(decoded);
            return true;
        }
    } catch {
        return false;
    }
}

function normalizeSecretKey(input) {
    if (input.startsWith('[')) {
        const arr = JSON.parse(input);
        return bs58.encode(Uint8Array.from(arr));
    } else {
        return input.trim();
    }
}

function encryptEnvString(envString, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(envString, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload = Buffer.concat([salt, iv, authTag, encrypted]);
    fs.writeFileSync('.env.enc', payload);

    console.log('\n[+] .env.enc file created successfully and secured!\n');
}

function banner() {
    console.log("Auto Buybot Setup\n");
}

async function main() {
    banner();

    const secretKeys = [];

    while (true) {
        const keyInput = await ask('Paste your wallet secret key (bs58-encoded or byte array): ');

        if (!isValidSecretKey(keyInput)) {
            console.log("[!] Invalid secret key format. Please try again.\n");
            continue;
        }

        const normalizedKey = normalizeSecretKey(keyInput);
        const wallet = Keypair.fromSecretKey(bs58.decode(normalizedKey));
        console.log(`[+] Wallet detected: ${wallet.publicKey.toBase58()}`);
        secretKeys.push(normalizedKey);

        const more = (await ask('Add another wallet? (y/n): ')).toLowerCase();
        if (more !== 'y') {
            break;
        }
    }

    // --- Prepare .env content in memory
    const envString = `SECRET_KEYS=${JSON.stringify(secretKeys, null, 0)}\n`;

    // --- Setup config.json ---
    const walletConfigs = [];

    for (const secret of secretKeys) {
        const wallet = Keypair.fromSecretKey(bs58.decode(secret));
        const pubkey = wallet.publicKey.toBase58();
        console.log(`\nWallet: ${pubkey}`);

        let name = "";
        name = await ask(`Please type a name for this wallet: `);
        if (!name) {
            name = pubkey;
        }

        let tokenMint = "";
        while (!tokenMint) {
            tokenMint = await ask(`Enter the token mint address to auto-buy for this wallet: `);
            if (!tokenMint) {
                console.log("[!] Token mint cannot be empty. Please try again.");
            }
        }

        walletConfigs.push({
            name: name,
            walletAddress: pubkey,
            tokenAddress: tokenMint
        });

        console.log(`[*] Configured wallet ${pubkey} to buy token ${tokenMint}`);
    }

    const config = {
        delayInMinutes: 2.5,
        rpcUrl: "https://api.mainnet-beta.solana.com",
        wallets: walletConfigs
    };

    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    console.log('\n[+] config.json generated successfully!\n');

    // --- Encrypt the .env string directly ---
    const password = await ask('Enter a password to encrypt your secret keys: ');
    encryptEnvString(envString, password);

    console.clear();
    console.log(`✅ Setup complete! You can now run your bot with 'node main.js' 🚀\n`);
    rl.close();
}

main();
