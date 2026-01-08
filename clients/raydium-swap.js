import { Connection, PublicKey, Keypair, VersionedTransaction, Transaction, AddressLookupTableAccount } from '@solana/web3.js';
import { 
    getAssociatedTokenAddress, 
    getMint, 
    TOKEN_PROGRAM_ID, 
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAccount
} from '@solana/spl-token';
import axios from 'axios';
import { API_URLS } from '@raydium-io/raydium-sdk-v2';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL = WRAPPED_SOL_MINT;
const SOL_DECIMALS = 9;

// Create axios instance for Raydium API
let baseURL = process.env.RAYDIUM_API_URL || 'https://transaction-v1.raydium.io/';
baseURL = baseURL.replace(/\/$/, '');

const raydiumAxios = axios.create({
    baseURL: baseURL,
});

/**
 * Format lamports to human-readable SOL amount
 */
function formatSOL(lamports) {
    return (lamports / 1e9).toFixed(9).replace(/\.?0+$/, '');
}

/**
 * Format token amount using decimals
 */
function formatToken(amount, decimals = 6) {
    return (amount / Math.pow(10, decimals)).toLocaleString('en-US', {
        maximumFractionDigits: decimals,
        minimumFractionDigits: 0
    });
}

/**
 * Get swap data from Raydium API (swapping SOL -> Token)
 */
async function getSwapData(inputMint, outputMint, amountIn, slippageBps = 100) {
    try {
        const endpoint = '/compute/swap-base-in';
        
        const { data: resp } = await raydiumAxios.get(endpoint, {
            params: {
                inputMint: inputMint,
                outputMint: outputMint,
                amount: amountIn.toString(),
                slippageBps: slippageBps,
                txVersion: 'V0',
            },
        });

        return resp;
    } catch (error) {
        if (error.response) {
            if (error.response.status === 404) {
                console.error('❌ Raydium API endpoint not found');
                throw new Error('Raydium API endpoint not available');
            }
            console.error(`❌ Raydium API error: ${error.response.status}`);
        } else {
            console.error(`❌ Network error: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Get priority fee from Raydium
 * Set to 0 as requested
 */
async function getPriorityFee() {
    // Return 0 for priority fee (no priority fee)
    return '0';
}

/**
 * Ensure the output token ATA exists with the correct token program
 */
async function ensureOutputATA(connection, wallet, outputMint) {
    try {
        const outputMintPubkey = new PublicKey(outputMint);
        const outputTokenProgram = await detectTokenProgram(connection, outputMint);
        
        console.log(`  🔍 Detected token program: ${outputTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token'}`);
        
        const outputAta = await getAssociatedTokenAddress(
            outputMintPubkey,
            wallet.publicKey,
            true,
            outputTokenProgram
        );

        // Check if the ATA already exists
        try {
            await getAccount(connection, outputAta, 'confirmed', outputTokenProgram);
            console.log(`  ✓ Output token account already exists`);
            return outputAta;
        } catch (error) {
            // ATA doesn't exist, create it
            console.log(`  📝 Creating output token account with ${outputTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token'} program...`);
            const createATAInstruction = createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                outputAta,
                wallet.publicKey,
                outputMintPubkey,
                outputTokenProgram,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            const transaction = new Transaction().add(createATAInstruction);
            const signature = await connection.sendTransaction(transaction, [wallet], {
                skipPreflight: true,
                maxRetries: 3
            });

            console.log(`  🔗 ATA creation tx: https://solscan.io/tx/${signature}`);

            // Wait for confirmation
            const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash({
                commitment: 'finalized',
            });
            
            await connection.confirmTransaction(
                {
                    blockhash,
                    lastValidBlockHeight,
                    signature: signature,
                },
                'confirmed'
            );
            
            console.log(`  ✅ Output token account created successfully`);
            return outputAta;
        }
    } catch (error) {
        console.error(`  ⚠️  Error ensuring output ATA: ${error.message}`);
        // Fallback: return the ATA address anyway
        const outputMintPubkey = new PublicKey(outputMint);
        const outputTokenProgram = await detectTokenProgram(connection, outputMint);
        return await getAssociatedTokenAddress(
            outputMintPubkey,
            wallet.publicKey,
            true,
            outputTokenProgram
        );
    }
}

/**
 * Get wrapped SOL ATA (for SOL input swaps)
 */
async function getWSOLAta(wallet) {
    const wrappedSolMint = new PublicKey(WRAPPED_SOL_MINT);
    return await getAssociatedTokenAddress(
        wrappedSolMint,
        wallet.publicKey,
        false, // allowOwnerOffCurve = false for wrapped SOL
        TOKEN_PROGRAM_ID // Wrapped SOL always uses standard Token program
    );
}

/**
 * Serialize swap transaction
 */
async function serializeSwapTransaction(connection, computeData, wallet, inputMint, outputMint) {
    try {
        const priorityFee = await getPriorityFee();
        const inputMintPubkey = new PublicKey(inputMint);
        const isSOLInput = inputMint === WRAPPED_SOL_MINT;
        const isSOLOutput = outputMint === WRAPPED_SOL_MINT;
        
        // Get input account - for SOL use wrapped SOL ATA, for tokens use token ATA
        let inputAccount;
        if (isSOLInput) {
            // Use wrapped SOL ATA for SOL input (like volumebot does)
            const wrappedSolAta = await getWSOLAta(wallet);
            inputAccount = wrappedSolAta.toBase58();
        } else {
            const inputTokenProgram = await detectTokenProgram(connection, inputMint);
            inputAccount = (await getAssociatedTokenAddress(
                inputMintPubkey, 
                wallet.publicKey, 
                true, 
                inputTokenProgram
            )).toBase58();
        }
        
        // Check token program for logging
        const outputTokenProgram = await detectTokenProgram(connection, outputMint);
        const isToken2022 = outputTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
        if (isToken2022) {
            console.log(`  🔍 Token uses Token-2022 program - Raydium will handle ATA creation`);
        }
        
        // Match volumebot pattern: wrapSol for SOL input, unwrapSol for SOL output
        const payload = {
            computeUnitPriceMicroLamports: priorityFee,
            swapResponse: computeData,
            txVersion: 'V0',
            wallet: wallet.publicKey.toBase58(),
            wrapSol: isSOLInput, // Wrap SOL when input is SOL
            unwrapSol: isSOLOutput, // Unwrap SOL when output is SOL
            inputAccount: inputAccount,
        };
        
        const { data: resp } = await raydiumAxios.post('/transaction/swap-base-in', payload);

        if (!resp || !resp.data) {
            throw new Error('Invalid response from transaction serialization endpoint');
        }

        return resp;
    } catch (error) {
        if (error.response) {
            const errorMsg = error.response.data?.msg || error.message;
            console.error(`❌ Transaction serialization failed: ${errorMsg}`);
        } else {
            console.error(`❌ Transaction serialization error: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Detect which token program a mint uses (Token or Token-2022)
 */
async function detectTokenProgram(connection, mintAddress) {
    try {
        const mintPubkey = new PublicKey(mintAddress);
        // Try to get the mint account info
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        if (!accountInfo) {
            // Default to standard Token program if we can't determine
            return TOKEN_PROGRAM_ID;
        }
        
        // Check if the owner is Token-2022 program
        if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            return TOKEN_2022_PROGRAM_ID;
        }
        
        // Default to standard Token program
        return TOKEN_PROGRAM_ID;
    } catch (error) {
        // Default to standard Token program on error
        return TOKEN_PROGRAM_ID;
    }
}

/**
 * Get token decimals from mint address
 */
async function getTokenDecimals(connection, mintAddress) {
    try {
        const tokenProgram = await detectTokenProgram(connection, mintAddress);
        const mint = await getMint(connection, new PublicKey(mintAddress), undefined, tokenProgram);
        return mint.decimals;
    } catch (error) {
        // Default to 6 decimals if we can't fetch
        return 6;
    }
}

/**
 * Get a quote from Raydium (without executing the swap)
 * Raydium's API automatically routes through the best available pool
 */
export async function getQuote(connection, inputMint, outputMint, lamports) {
    try {
        const computeData = await getSwapData(inputMint, outputMint, lamports, 100);
        if (!computeData || (!computeData.data && !computeData.outputAmount)) {
            throw new Error('Invalid swap data response from Raydium');
        }
        const swapResponse = computeData.data || computeData;
        
        // Raydium's compute/swap-base-in endpoint automatically finds the best route
        // It checks all available pools and routes through the one with the best price
        // The response includes price impact which indicates routing efficiency
        
        return {
            outAmount: BigInt(swapResponse.outputAmount),
            provider: 'raydium',
            priceImpact: swapResponse.priceImpact || 0,
            swapType: swapResponse.swapType || 'unknown',
            // Include full response for debugging
            _rawResponse: swapResponse
        };
    } catch (error) {
        throw new Error(`Raydium quote failed: ${error.message}`);
    }
}

/**
 * Execute a swap on Raydium (SOL -> Token)
 */
export async function swap(connection, keyPair, inputMint, outputMint, lamports) {
    try {
        const solAmount = formatSOL(lamports);
        
        // Get swap computation data from Raydium
        const computeData = await getSwapData(inputMint, outputMint, lamports, 100);
        
        if (!computeData || (!computeData.data && !computeData.outputAmount)) {
            throw new Error('Invalid swap data response from Raydium');
        }

        const swapResponse = computeData.data || computeData;
        
        // Get token decimals for formatting
        const tokenDecimals = await getTokenDecimals(connection, outputMint);
        const tokenAmount = formatToken(swapResponse.outputAmount, tokenDecimals);
        const priceImpact = swapResponse.priceImpact ? (swapResponse.priceImpact * 100).toFixed(2) : 'N/A';
        
        console.log(`  💱 Quote: ${tokenAmount} tokens for ${solAmount} SOL (${priceImpact}% price impact)`);

        // Serialize the swap transaction
        // Note: We don't pre-create the output ATA - Raydium handles Token-2022 automatically
        const serializedData = await serializeSwapTransaction(
            connection,
            computeData,
            keyPair,
            inputMint,
            outputMint
        );

        if (!serializedData || !serializedData.data || serializedData.data.length === 0) {
            throw new Error('Failed to serialize swap transaction');
        }

        // Deserialize all transactions
        const allTxBuf = serializedData.data.map((tx) =>
            Buffer.from(tx.transaction, 'base64')
        );
        let allTransactions = allTxBuf.map((txBuf) =>
            VersionedTransaction.deserialize(txBuf)
        );

        // Raydium should handle Token-2022 automatically
        // No need to patch transactions

        // Sign and send all transactions
        let lastSignature = null;
        for (let idx = 0; idx < allTransactions.length; idx++) {
            const transaction = allTransactions[idx];
            transaction.sign([keyPair]);

            if (allTransactions.length > 1) {
                console.log(`  📤 Sending transaction ${idx + 1}/${allTransactions.length}...`);
            }
            
            const signature = await connection.sendTransaction(transaction, {
                skipPreflight: true,
                maxRetries: 3
            });

            lastSignature = signature;
            console.log(`  🔗 Transaction: https://solscan.io/tx/${signature}`);

            // Wait for confirmation
            const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash({
                commitment: 'finalized',
            });

            await connection.confirmTransaction(
                {
                    blockhash,
                    lastValidBlockHeight,
                    signature: signature,
                },
                'confirmed'
            );

            if (allTransactions.length > 1) {
                console.log(`  ✅ Transaction ${idx + 1} confirmed`);
            }
            
            // Wait between transactions if multiple
            if (idx < allTransactions.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        console.log(`  ✅ Swap completed successfully!`);

        return {
            outAmount: swapResponse.outputAmount,
            outputSymbol: outputMint,
            inputSymbol: inputMint,
            signature: lastSignature
        };
    } catch (error) {
        throw new Error(`Raydium swap failed: ${error.message}`);
    }
}

