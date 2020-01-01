import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

import fetch from "node-fetch";

const configFilename = "config.json";
const authDomain = "cnunciato-test"; // This hostname must be globally unique.

// If using a custom domain, set these up also.
const gatewayDomain = "nunciato.org";
const gatewayHostname = `api.${gatewayDomain}`;
const certificateArn = "arn:aws:acm:us-east-1:639972025873:certificate/044552ff-3c88-46d8-af77-ddcb366af26c";
const region = "us-east-1";
const basePath = "stage";

interface AppConfig {
    clientID: string;
    redirectUrl: string;
    authEndpoint: string;
    apiUrl: string;
    signUpUrl: string;
    signInUrl: string;
}

const pool = new aws.cognito.UserPool("pool", {
    usernameAttributes: ["email"],
    autoVerifiedAttributes: ["email"],
});

const domain = new aws.cognito.UserPoolDomain("domain", {
    userPoolId: pool.id,
    domain: authDomain,
});

async function getAppConfig(): Promise<AppConfig> {
    const s3 = new aws.sdk.S3();
    const file = await s3.getObject({ Bucket: bucket.id.get(), Key: configFilename }).promise();

    if (!file || !file.Body) {
        throw new Error("Doh!");
    }

    let config: AppConfig = JSON.parse(file.Body.toString());
    return Promise.resolve(config);
}

const api = new awsx.apigateway.API("api", {
    routes: [
        {
            path: "/",
            localPath: "www",
        },
        {
            path: "/config",
            method: "GET",
            eventHandler: async (event) => {
                return {
                    statusCode: 200,
                    body: JSON.stringify(await getAppConfig()),
                }
            }
        },
        {
            path: "/callback",
            method: "GET",
            eventHandler: async (event) => {
                event.headers

                if (!event.queryStringParameters || !event.queryStringParameters.code) {
                    return {
                       statusCode: 400,
                       body: "Bad request. Code property was missing.",
                    };
                }

                const code = event.queryStringParameters.code;
                const config = await getAppConfig();

                const params = [
                    `grant_type=authorization_code`,
                    `client_id=${config.clientID}`,
                    `redirect_uri=${config.redirectUrl}`,
                    `code=${code}`,
                ];

                const resp = await fetch(`${config.authEndpoint}/oauth2/token`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: params.join("&"),
                });

                const token = await resp.json();

                return {
                    statusCode: 302,
                    body: JSON.stringify({}),
                    headers: {
                        "Set-Cookie": `id=${token.id_token}`,
                        "Location": `${config.apiUrl}?id=${token.id_token}`
                    },
                };
            }
        },
        {
            path: "/api",
            method: "GET",
            authorizers: [
                awsx.apigateway.getCognitoAuthorizer({
                    providerARNs: [
                        pool,
                    ]
                }),
            ],
            eventHandler: async (event) => {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ awesome: true }),
                };
            },
        },
    ],
});

function useCustomDomain() {
    return gatewayDomain && gatewayHostname && basePath;
}

if (useCustomDomain()) {
    setUpCustomDomain();
}

async function setUpCustomDomain() {
    const zone = await aws.route53.getZone({ name: gatewayDomain });

    const domainName = new aws.apigateway.DomainName("domain", {
        domainName: gatewayHostname,
        certificateArn,
    });

    const basePathMapping = new aws.apigateway.BasePathMapping("mapping", {
        domainName: domainName.domainName,
        restApi: api.restAPI,
        stageName: api.stage.stageName,
        basePath,
    });

    const alias = new aws.route53.Record("alias", {
        name: gatewayHostname,
        type: "A",
        zoneId: zone.id,
        aliases: [
            {
                name: domainName.cloudfrontDomainName,
                zoneId: domainName.cloudfrontZoneId,
                evaluateTargetHealth: false,
            },
        ],
    });
}

const client = new aws.cognito.UserPoolClient("client", {
    userPoolId: pool.id,
    generateSecret: false,
    allowedOauthFlowsUserPoolClient: true,
    supportedIdentityProviders: [
        "COGNITO" // This should probably be a constant/enum.
    ],
    allowedOauthFlows: [
        "code",
    ],
    allowedOauthScopes: [
        "email",
        "profile",
        "openid",
        "aws.cognito.signin.user.admin",
    ],
    callbackUrls: [
        getAPIUrl("callback"),
    ],
    logoutUrls: [
        getAPIUrl("logout"),
    ],
});

const config = pulumi.all([client.id, getAPIUrl(), getAPIUrl("callback"), domain.domain]).apply(([clientID, apiUrl, callbackUrl, authEndpoint]) => {
    const cognitoUrl = `https://${authEndpoint}.auth.${region}.amazoncognito.com`;
    const cognitoUrlParams = `client_id=${clientID}&response_type=code&redirect_uri=${callbackUrl}`;

    const c: AppConfig = {
        clientID,
        apiUrl: apiUrl,
        redirectUrl: callbackUrl,
        authEndpoint: cognitoUrl,
        signUpUrl: `${cognitoUrl}/signup?${cognitoUrlParams}`,
        signInUrl: `${cognitoUrl}/login?${cognitoUrlParams}`,
    };

    return JSON.stringify(c);
});

// Note that the bucket is not publicly accessible; only the gateway has access to it.
const bucket = new aws.s3.Bucket("bucket", { forceDestroy: true });
const bucketObject = new aws.s3.BucketObject(configFilename, {
    bucket,
    contentType: "application/json",
    content: config,
});

function getAPIUrl(path?: string): pulumi.Output<string> {
    if (useCustomDomain()) {
        return pulumi.output(`https://${gatewayHostname}/${basePath}/${path ? path + '/' : ""}`);
    }
    return api.url;
}

export const apiUrl = getAPIUrl();
export const bucketName = bucket.id;
