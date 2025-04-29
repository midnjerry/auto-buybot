import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline';
import dotenv from 'dotenv';

function askHidden(question) {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdin.resume();
    stdout.write(question);

    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    return new Promise((resolve, reject) => {
        let password = '';

        const onData = (char) => {
            if (char === '\n' || char === '\r' || char === '\u0004') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                stdout.write('\n');
                resolve(password);
            } else if (char === '\u0003') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                stdout.write('\n');
                reject(new Error('Interrupted'));
            } else if (char === '\u007f') {
                // Handle backspace
                password = password.slice(0, -1);
                readline.cursorTo(stdout, 0);
                stdout.write(question + '*'.repeat(password.length));
            } else {
                password += char;
                stdout.write('*');
            }
        };

        stdin.on('data', onData);
    });
}

async function loadEncryptedSecretKeys() {
    if (!fs.existsSync('.env.enc')) {
        throw new Error('[!] file with keys not found!  Please run `node setup-bot.js`');
    }

    const payload = fs.readFileSync('.env.enc');

    const salt = payload.slice(0, 16);
    const iv = payload.slice(16, 28);
    const authTag = payload.slice(28, 44);
    const encrypted = payload.slice(44);

    try {
        const password = await askHidden('Enter password to load secret keys: ');

        const key = crypto.scryptSync(password, salt, 32);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const envString = decrypted.toString('utf8');

        const parsedEnv = dotenv.parse(envString);
        for (const key in parsedEnv) {
            process.env[key] = parsedEnv[key];
        }

        console.log('[+] Secret Keys loaded successfully!\n');
    } catch (error) {
        console.error('[!] Failed to decrypt secret keys', error.message);
        process.exit(1);
    }
}

export { loadEncryptedSecretKeys };
