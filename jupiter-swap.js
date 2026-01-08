import { VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';
import { Wallet } from '@project-serum/anchor';

const ROOT_QUOTE_URL='https://api.jup.ag/swap/v1/quote';
const ROOT_SWAP_URL='https://api.jup.ag/swap/v1/swap';

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function swap(connection, keyPair, inputMint, outputMint, lamports) {
    const wallet = new Wallet(keyPair);
    
    
    // retrieve indexed routed map
    let response;
    try {
        response = await axios.get(`${ROOT_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${lamports}&slippageBps=50`, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
    } catch (error) {
        if (error.response) {
            console.error('Jupiter API Error:', error.response.status, error.response.data);
            // If 401, it might be that Jupiter requires authentication now
            if (error.response.status === 401) {
                console.error('Jupiter API returned 401 Unauthorized. The API may now require authentication or the endpoint has changed.');
                console.error('Please check https://docs.jup.ag/ for the latest API documentation.');
            }
            throw new Error(`Jupiter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }

    const quoteResponse = response.data;
    
    if (!quoteResponse) {
        throw new Error('Failed to get quote from Jupiter API');
    }
    
    const body = {
        // quoteResponse from /quote api
        quoteResponse: quoteResponse,
        // user public key to be used for the swap
        userPublicKey: keyPair.publicKey,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        // auto wrap and unwrap SOL. default is true
        wrapAndUnwrapSol: true,
        // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
        // feeAccount: "fee_account_public_key"
    };

    // get serialized transactions for the swap
    try {
        response = await axios.post(ROOT_SWAP_URL, body);
    } catch (error) {
        if (error.response) {
            console.error('Jupiter Swap API Error:', error.response.status, error.response.data);
            throw new Error(`Jupiter Swap API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }

    const { swapTransaction } = response.data;

    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // sign the transaction
    transaction.sign([wallet.payer]);

    // Execute the transaction
    var tryAgain = true;
    var objSignatureStatusResult;
    var maxTriesCounter = 0;
    var maxTries = 5;

    while (tryAgain) {
        maxTriesCounter++;
        const rawTransaction = transaction.serialize()
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        console.log(`https://solscan.io/tx/${txid}`);
        await wait(10000);

        const result = await connection.getSignatureStatus(txid, {
            searchTransactionHistory: true,
        });
        objSignatureStatusResult = JSON.parse(JSON.stringify(result));
        console.log('objSignatureResult', objSignatureStatusResult);
        if (objSignatureStatusResult.value !== null) tryAgain = false;
        if (maxTriesCounter > maxTries) tryAgain = false;
    }
    return quoteResponse;
}

