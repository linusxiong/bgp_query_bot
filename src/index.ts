import { Bot, Context, CommandContext } from "grammy";
import { limit } from "@grammyjs/ratelimiter";
import {
    ignoreOld,
} from "grammy-middlewares";
import {autoRetry} from "@grammyjs/auto-retry";
// Operator mappings and interfaces remain the same
const OPERATOR_MAPPING: Record<string, string> = {
    "12956": "Telxius",
    "1299": "Telia",
    "174": "Cogent",
    "2914": "NTT",
    "3257": "GTT",
    "3320": "DTAG",
    "3356": "Lumen",
    "3491": "PCCW",
    "5511": "Orange",
    "6453": "TATA Communications",
    "6461": "Zayo",
    "6762": "Sparkle",
    "6830": "Liberty",
    "701": "Verizon",
    "7018": "AT&T",
    "4637": "Telstra",
    "6939": "HE",
    "9002": "RETN",
    "137409": "GSL",
    "24482": "SG.GS",
    "21859": "Zenlayer",
    "16276": "OVH",
    "24940": "Hetzner",
    "35280": "F5",
    "3214": "xTom",
    "49981": "WorldStream",
    "49544": "i3D",
    "30844": "Liquid",
    "396998": "Path",
    "34927": "iFog",
    "13335": "Cloudflare",
    "15169": "Google",
    "8075": "Microsoft",
    "16509": "AWS",
    "4134": "China Telecom",
    "23764": "CTG",
    "4809": "CN2",
    "4837": "China Unicom",
    "9929": "CU2",
    "10099": "CUG",
    "58807": "CMIN2",
    "58453": "CMI",
    "9808": "CM",
    "4538": "CERN",
    "23910": "CERN2",
    "1273": "Vodafone",
    "2828": "Verizon",
    "7922": "Comcast",
    "3216": "VEON",
    "9498": "Bharti Airtel",
    "4766": "Korea Telecom",
    "577": "Bell Canada",
    "3303": "Swisscom",
    "7473": "Singtel",
    "4826": "VOCUS",
    "9299": "Philippine Long Distance",
    "4755": "TATA India",
    "906": "DMIT",
    "54574": "DMIT",
    "32519": "DMIT",
    "57695": "Misaka",
    "917": "Misaka",
    "969": "Misaka",
    "35487": "Misaka",
};

interface ASNInfo {
    asn: string;
    country: string;
    descr: string;
    org?: string;
}

interface ASPath {
    type: number;
    asns: number[];
}

interface BGPRoute {
    prefix: string;
    aspath: ASPath[];
    neighborip: string;
    origin: number;
    asnmap: Record<string, ASNInfo>;
}

interface BGPResponse {
    count: number;
    response: BGPRoute[];
}

interface PathInfo {
    path: string;
    count: number;
    percentage: number;
    tier: string;
}

interface CombinedResults {
    heData?: BGPResponse;
    bgpToolsData?: BGPResponse;
    error?: {
        he?: Error;
        bgpTools?: Error;
    };
}

// Utility functions
function isTier1ASN(asn: string): boolean {
    return OPERATOR_MAPPING.hasOwnProperty(asn);
}

function deduplicatePath(path: string[]): string[] {
    return path.filter((asn, index) => asn !== path[index + 1]);
}

function getASNName(asn: string, asnmap: Record<string, ASNInfo>): string {
    const mappedName = OPERATOR_MAPPING[asn];
    if (mappedName) return mappedName;

    const asnInfo = asnmap[asn];
    if (asnInfo?.org) return asnInfo.org;
    if (asnInfo?.descr) {
        return asnInfo.descr
            .split(',')[0]
            .split('-')[0]
            .replace(/\s(AS|Ltd\.?|Inc\.?|Corp\.?|Limited|Corporation)$/i, '')
            .trim();
    }
    return asn;
}

// HE.net API function
async function fetchHEData(cidr: string): Promise<BGPResponse> {
    const response = await fetch(
        `https://bgp.he.net/super-lg/api/v1/show/bgp/route/${cidr}?match-asn=&match-type=all&match-neighbor=`,
        {
            headers: {
                "User-Agent": "BGP-Query-Bot/1.0"
            }
        }
    );

    if (!response.ok) {
        throw new Error(`HE.net HTTP error! status: ${response.status}`);
    }

    return await response.json() as BGPResponse;
}

// BGP.tools API function
async function fetchBGPToolsData(cidr: string): Promise<BGPResponse> {
    const response = await fetch(
        `https://bgp.tools/super-lg`,
        {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `q=${encodeURIComponent(cidr)}&asnmatch=`
        }
    );

    if (!response.ok) {
        throw new Error(`BGP.tools HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const routes: BGPRoute[] = [];
    const allASNInfo: Record<string, ASNInfo> = {};

    const pathBlocks = html.split('unicast').slice(1);

    pathBlocks.forEach(block => {
        const asPath: ASPath = {
            type: 1,
            asns: []
        };

        const asMatches = Array.from(block.matchAll(/<abbr[^>]*title="([^"]*)"[^>]*>(\d+)<\/abbr>/g));
        asMatches.forEach(match => {
            const [, orgName, asNum] = match;
            const asn = parseInt(asNum);
            asPath.asns.push(asn);

            allASNInfo[asNum] = {
                asn: asNum,
                country: '',
                descr: orgName
            };
        });

        if (asPath.asns.length > 0) {
            routes.push({
                prefix: cidr,
                aspath: [asPath],
                neighborip: '',
                origin: 0,
                asnmap: allASNInfo
            });
        }
    });

    return {
        count: routes.length,
        response: routes
    };
}

async function fetchAllSources(input: string): Promise<CombinedResults> {
    let cidr: string;

    // Check if input is already a valid CIDR
    if (isValidIPv4CIDR(input) || isValidIPv6CIDR(input)) {
        cidr = input;
    } else {
        // If not, try to get the correct CIDR from BGP.tools
        try {
            cidr = await getCorrectCIDR(input);
        } catch (error) {
            throw new Error(`Invalid input: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    const results: CombinedResults = {};

    const [heResult, bgpToolsResult] = await Promise.allSettled([
        fetchHEData(cidr).catch(error => {
            console.error('Error fetching from HE:', error);
            results.error = { ...results.error, he: error };
            return null;
        }),
        fetchBGPToolsData(cidr).catch(error => {
            console.error('Error fetching from BGP.tools:', error);
            results.error = { ...results.error, bgpTools: error };
            return null;
        })
    ]);

    if (heResult.status === 'fulfilled' && heResult.value) {
        results.heData = heResult.value;
    }
    if (bgpToolsResult.status === 'fulfilled' && bgpToolsResult.value) {
        results.bgpToolsData = bgpToolsResult.value;
    }

    return results;
}

// Merge and analyze function
async function analyzeBGPData(cidr: string): Promise<string> {
    try {
        const combinedResults = await fetchAllSources(cidr);

        if (!combinedResults.heData && !combinedResults.bgpToolsData) {
            throw new Error('No data available from any source');
        }

        // Collect all unique routes
        const allRoutes: BGPRoute[] = [];
        const allASNMap: Record<string, ASNInfo> = {};
        let heCount = 0, bgpToolsCount = 0;

        if (combinedResults.heData) {
            heCount = combinedResults.heData.count;
            combinedResults.heData.response.forEach(route => {
                allRoutes.push(route);
                Object.assign(allASNMap, route.asnmap);
            });
        }

        if (combinedResults.bgpToolsData) {
            bgpToolsCount = combinedResults.bgpToolsData.count;
            combinedResults.bgpToolsData.response.forEach(route => {
                const pathString = route.aspath[0].asns.join(',');
                const exists = allRoutes.some(r =>
                    r.aspath[0].asns.join(',') === pathString
                );

                if (!exists) {
                    allRoutes.push(route);
                    Object.assign(allASNMap, route.asnmap);
                }
            });
        }

        // Check if we have any valid routes
        if (allRoutes.length === 0) {
            return `查询CIDR段: ${cidr}\n未找到任何有效的BGP路由信息。`;
        }

        const totalPaths = allRoutes.length;

        const tierStats = {
            direct: new Map<string, number>(),
            tier1: new Map<string, number>(),
            tier2: new Map<string, number>(),
            tier3: new Map<string, number>()
        };

        // Process each route with safety checks
        allRoutes.forEach(route => {
            if (!route.aspath?.[0]?.asns) return;

            const asPath = route.aspath[0].asns.map(asn => asn.toString());
            const dedupedASNs = deduplicatePath(asPath);
            const namedPath = dedupedASNs.map(asn => getASNName(asn, allASNMap));

            namedPath[namedPath.length - 1] = 'END';
            const pathLength = dedupedASNs.length;

            if (pathLength <= 2 && !isTier1ASN(dedupedASNs[0])) {
                const pathKey = 'DIRECT';
                tierStats.direct.set(pathKey, (tierStats.direct.get(pathKey) || 0) + 1);
            }

            if (pathLength >= 2) {
                const tier1AsNum = dedupedASNs[dedupedASNs.length - 2];
                if (isTier1ASN(tier1AsNum)) {
                    const tier1String = namedPath[namedPath.length - 2];
                    tierStats.tier1.set(tier1String, (tierStats.tier1.get(tier1String) || 0) + 1);
                }
            }

            if (pathLength >= 3) {
                const tier2String = namedPath.slice(-3).join(' -> ');
                tierStats.tier2.set(tier2String, (tierStats.tier2.get(tier2String) || 0) + 1);
            }

            if (pathLength >= 4) {
                const tier3String = namedPath.slice(-4).join(' -> ');
                tierStats.tier3.set(tier3String, (tierStats.tier3.get(tier3String) || 0) + 1);
            }
        });

        function convertToSortedArray(map: Map<string, number>, tier: string): PathInfo[] {
            return Array.from(map.entries())
                .map(([path, count]) => ({
                    path,
                    count,
                    percentage: (count / totalPaths) * 100,
                    tier
                }))
                .sort((a, b) => b.percentage - a.percentage)
                .slice(0, 5);
        }

        const allPaths = [
            ...convertToSortedArray(tierStats.direct, 'DIRECT'),
            ...convertToSortedArray(tierStats.tier1, 'T1'),
            ...convertToSortedArray(tierStats.tier2, 'T2'),
            ...convertToSortedArray(tierStats.tier3, 'T3')
        ];

        // Safely get target ASN information
        let targetASN = '';
        let asnInfo: ASNInfo | undefined;

        if (allRoutes[0]?.aspath?.[0]?.asns?.length > 0) {
            targetASN = allRoutes[0].aspath[0].asns.at(-1)?.toString() || '';
            asnInfo = allASNMap[targetASN];
        }

        const message = [
            `查询CIDR段: ${cidr}`,
            targetASN ? `ASN号: ${targetASN}` : '未找到ASN信息',
            asnInfo ? `ASN名: ${asnInfo.org || asnInfo.descr || 'Unknown'}` : '',
            asnInfo ? `地区: ${asnInfo.country || 'Unknown'}` : '',
            '',
            '\n数据源统计:',
            `- HE.net: ${heCount > 0 ? `${heCount}条路由` : '获取失败'}`,
            `- BGP.tools: ${bgpToolsCount > 0 ? `${bgpToolsCount}条路由` : '获取失败'}`,
            `- 合并去重后: ${totalPaths}条路由`,
            '',
            '\n路由分析:',
            ...allPaths.slice(0, 15).map(({path, percentage, tier}) =>
                `${percentage.toFixed(1)}% [${tier}] ${path}`
            )
        ].filter(Boolean).join('\n');

        return message;

    } catch (error) {
        console.error('Error analyzing BGP data:', error);
        return `查询出错: ${error instanceof Error ? error.message : '未知错误'}\n请稍后重试。`;
    }
}

// Validate if string is IPv4 CIDR
function isValidIPv4CIDR(cidr: string): boolean {
    const parts = cidr.split('/');
    if (parts.length !== 2) return false;

    const [ip, prefix] = parts;
    const ipParts = ip.split('.');
    const prefixNum = parseInt(prefix);

    if (ipParts.length !== 4) return false;
    if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) return false;

    return ipParts.every(part => {
        const num = parseInt(part);
        return !isNaN(num) && num >= 0 && num <= 255;
    });
}

// Validate if string is IPv6 CIDR
function isValidIPv6CIDR(cidr: string): boolean {
    const parts = cidr.split('/');
    if (parts.length !== 2) return false;

    const [ip, prefix] = parts;
    const prefixNum = parseInt(prefix);

    if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) return false;

    // Basic IPv6 validation using regex
    const ipv6Regex = /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(?:ffff(?::0{1,4}){0,1}:){0,1}(?:(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

    return ipv6Regex.test(ip);
}

// Function to get correct CIDR from BGP.tools
async function getCorrectCIDR(input: string): Promise<string> {
    try {
        const response = await fetch(`https://bgp.tools/prefix/${input}`, {
            method: 'GET',
            redirect: 'manual', // Don't automatically follow redirects
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'
            }
        });

        if (response.status === 307) {
            const location = response.headers.get('location');
            if (location) {
                const match = location.match(/\/prefix\/([\d\.:\/a-fA-F]+)/);
                if (match && match[1]) {
                    return match[1];
                }
            }
        }
        throw new Error('Unable to determine correct CIDR');
    } catch (error) {
        throw new Error(`Error getting correct CIDR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}


// Bot setup
const token = Bun.env.BOT_TOKEN;
if (!token) {
    console.error("Please set BOT_TOKEN environment variable");
    process.exit(1);
}

const bot = new Bot(token);

const limiter = limit({
    timeFrame: 2000,
    limit: 1,

    onLimitExceeded: async (ctx) => {
        await ctx.reply("请求过快，请稍后重试！");
    },
});

bot.command("start", limiter, async (ctx: CommandContext<Context>) => {
    await ctx.reply(
        "欢迎使用 BGP 路由查询机器人!\n" +
        "使用方法: /bgpmp <CIDR>\n" +
        "例如: /bgpmp 23.249.16.0/23"
    );
});

bot.command("bgpmp", limiter, async (ctx: CommandContext<Context>) => {
    const cidr = ctx.match as string;

    if (!cidr) {
        return ctx.reply(
            "请提供CIDR地址块。\n" +
            "例如: /bgpmp 23.249.16.0/23"
        );
    }

    const statusMessage = await ctx.reply("正在查询 BGP 数据...");

    try {
        const response = await analyzeBGPData(cidr);
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            response
        );
    } catch (error) {
        console.error('Error:', error);
        if (error instanceof Error && error.message?.includes('MESSAGE_TOO_LONG')) {
            await ctx.api.editMessageText(
                statusMessage.chat.id,
                statusMessage.message_id,
                "查询结果过长，请稍后重试。"
            );
        } else {
            await ctx.api.editMessageText(
                statusMessage.chat.id,
                statusMessage.message_id,
                "查询出错，请稍后重试。"
            );
        }
    }
});

bot.catch((err: Error) => {
    console.error("Bot error:", err);
});

console.log("Starting bot...");

bot.use(limiter)
bot.use(ignoreOld());
bot.api.config.use(autoRetry())

bot.start();
