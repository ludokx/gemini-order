const axios = require('axios');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const SSM = require('aws-sdk/clients/ssm');
AWS.config.update({ region: "us-west-2" });

if (process.env.AWS_PROFILE) {
    const credentials = new AWS.SharedIniFileCredentials({profile: process.env.AWS_PROFILE});
    AWS.config.credentials = credentials;
}

const getSecret = async (account) => {
    const ssm = new SSM()
    const params = await ssm.getParameters({
        Names: [account],
        WithDecryption: true
    }).promise();
    const secret = params.Parameters[0].Value;
    return secret;
}

const getApiHost = (sandbox) => {
    return sandbox ? 'https://api.sandbox.gemini.com/' : 'https://api.gemini.com';
}

const getHeaders = async (account, payload) => {
    const encodedPayload = (Buffer.from(JSON.stringify(payload))).toString(`base64`);

    const signature = crypto
        .createHmac(`sha384`, await getSecret(account))
        .update(encodedPayload)
        .digest(`hex`);

    return {
        'Content-Type': "text/plain",
        'Content-Length': "0",
        'X-GEMINI-APIKEY': `account-${account}`,
        'X-GEMINI-PAYLOAD': encodedPayload,
        'X-GEMINI-SIGNATURE': signature,
        'Cache-Control': "no-cache"
    };
}

const floor = (v, d) => {
    return (Math.floor(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
}

const newOrder = async (account, sandbox, symbol, fiatAmount, isMaker, includeFees) => {
    console.log('Retrieving current pricing data');
    const res = await axios.get(`${getApiHost(sandbox)}/v2/ticker/${symbol}`);
    console.log('Got current pricing data');
    console.log(res.data);
    const askingPrice = parseFloat(res.data.ask);
    console.log(`Asking price: ${askingPrice}`);
    const price = isMaker ? floor(askingPrice - 0.2, 2) : askingPrice;
    console.log(`Adjusted price: ${price}`);
    const feeAdjustment = includeFees ? 0.999 : 1;
    console.log(`Fee adjustment ratio: ${feeAdjustment}`);
    const amount = floor(fiatAmount * feeAdjustment / price, 6);
    console.log(`Amount: ${amount}`);
    const nonce = Date.now();
    const payload = {
        request: '/v1/order/new',
        nonce,
        symbol,
        amount,
        price,
        side: 'buy',
        type: 'exchange limit',
        options: isMaker ? ['maker-or-cancel'] : ['immediate-or-cancel']
    };

    try {
        const orderResponse = await axios({
            method: 'POST',
            url: `${getApiHost(sandbox)}/v1/order/new`,
            headers: await getHeaders(account, payload)
        });

        const data = orderResponse.data;
        console.log(data);
    } catch (e) {
        console.error(e);
    }
}

const main = async (event, context) => {
    if (!event.account) {
        throw new Error('Account not specified');
    }
    if (!event.symbol) {
        throw new Error('Symbol not specified');
    }
    if (!event.fiatAmount) {
        throw new Error('Fiat amount not specified');
    }
    const orderType = (event.orderType || 'taker').toLowerCase();
    console.log(`New ${orderType} order for \$${event.fiatAmount} worth of ${event.symbol.toUpperCase().replace('USD', '')}`);
    await newOrder(event.account, event.sandbox, event.symbol, event.fiatAmount, orderType === 'maker');
    if (context) {
        return context.logStreamName;
    }
};
if (process.env.LOCAL === 'true') {
    main({
        account: process.env.ACCOUNT,
        symbol: process.env.SYMBOL,
        fiatAmount: process.env.FIAT_AMOUNT,
        orderType: process.env.ORDER_TYPE,
        sandbox: process.env.SANDBOX === 'true'
    });
}

exports.handler = main;