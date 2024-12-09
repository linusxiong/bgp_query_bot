import { Bot, Context, CommandContext } from "grammy";

// Operator mappings and interfaces remain the same
const OPERATOR_MAPPING: Record<string, string> = {
    "5511": "Orange",
    "3257": "GTT",
    "6461": "Zayo",
    "6830": "Liberty",
    "174": "Cogent",
    "701": "Verizon",
    "1299": "Arelion",
    "2914": "NTT",
    "3491": "PCCW",
    "3356": "Lumen",
    "3320": "DTAG",
    "24482": "SG.GS",
    "4134": "China Telecom",
    "4809": "China Telecom",
    "9002": "RETN",
    "1273": "Vodafone",
    "2828": "Verizon",
    "4637": "Telstra",
    "7922": "Comcast",
    "3216": "VEON",
    "9498": "Bharti Airtel",
    "4538": "China Education Network",
    "4837": "China Unicom",
    "7018": "AT&T",
    "2497": "IIJ",
    "4766": "Korea Telecom",
    "577": "Bell Canada",
    "3303": "Swisscom",
    "6453": "TATA Communications",
    "6762": "Sparkle",
    "7473": "Singtel",
    "4826": "VOCUS",
    "6939": "HE",
    "9299": "Philippine Long Distance",
    "4755": "TATA India"
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

// Parallel fetch function
async function fetchAllSources(cidr: string): Promise<CombinedResults> {
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

        const totalPaths = allRoutes.length;

        // Rest of the analysis remains similar to original code
        const tierStats = {
            direct: new Map<string, number>(),
            tier1: new Map<string, number>(),
            tier2: new Map<string, number>(),
            tier3: new Map<string, number>()
        };

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

        // Build enhanced message with source information
        const targetASN = allRoutes[0].aspath[0].asns.at(-1)?.toString() || '';
        const asnInfo = allASNMap[targetASN];

        const message = [
            `查询CIDR段: ${cidr}`,
            `ASN号: ${targetASN}`,
            `ASN名: ${asnInfo?.org || asnInfo?.descr || 'Unknown'}`,
            `地区: ${asnInfo?.country || 'Unknown'}`,
            '',
            '数据源统计:',
            `- HE.net: ${heCount > 0 ? `${heCount}条路由` : '获取失败'}`,
            `- BGP.tools: ${bgpToolsCount > 0 ? `${bgpToolsCount}条路由` : '获取失败'}`,
            `- 合并去重后: ${totalPaths}条路由`,
            '',
            '路由分析:',
            ...allPaths.slice(0, 15).map(({path, percentage, tier}) =>
                `${percentage.toFixed(1)}% [${tier}] ${path}`
            )
        ].join('\n');

        return message;

    } catch (error) {
        console.error('Error analyzing BGP data:', error);
        return 'Error analyzing BGP data. Please try again later.';
    }
}

// Bot setup
const token = Bun.env.BOT_TOKEN;
if (!token) {
    console.error("Please set BOT_TOKEN environment variable");
    process.exit(1);
}

const bot = new Bot(token);

bot.command("start", async (ctx: CommandContext<Context>) => {
    await ctx.reply(
        "欢迎使用 BGP 路由查询机器人!\n" +
        "使用方法: /bgpmp <CIDR>\n" +
        "例如: /bgpmp 23.249.16.0/23"
    );
});

bot.command("bgpmp", async (ctx: CommandContext<Context>) => {
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
bot.start();