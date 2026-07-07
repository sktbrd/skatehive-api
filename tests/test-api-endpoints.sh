# API Endpoint Testing Script
# Skatehive Leaderboard API - Complete Test Suite

# Base URL (adjust if running on different port)
BASE_URL="http://localhost:3000"

echo "🛹 SKATEHIVE LEADERBOARD API TESTING SUITE 🛹"
echo "================================================="
echo ""

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to test endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local description=$3
    local data=$4
    
    echo -e "${BLUE}Testing:${NC} $method $endpoint"
    echo -e "${YELLOW}Description:${NC} $description"
    
    if [ "$method" = "GET" ]; then
        curl -s -w "\nStatus: %{http_code}\n" -H "Content-Type: application/json" "$BASE_URL$endpoint" | head -20
    elif [ "$method" = "POST" ]; then
        if [ -n "$data" ]; then
            curl -s -w "\nStatus: %{http_code}\n" -X POST -H "Content-Type: application/json" -d "$data" "$BASE_URL$endpoint" | head -20
        else
            curl -s -w "\nStatus: %{http_code}\n" -X POST -H "Content-Type: application/json" "$BASE_URL$endpoint" | head -20
        fi
    fi
    
    echo ""
    echo "---"
    echo ""
}

echo -e "${GREEN}🔥 V1 LEGACY ENDPOINTS${NC}"
echo "======================="

# V1 Legacy Endpoints
test_endpoint "GET" "/api/skatehive" "Fetch leaderboard data from Supabase"

test_endpoint "GET" "/api/ethHelpers?address=0x742d35Cc6634C0532925a3b8D162Be00C9B2A26F&method=balance" "Get Ethereum balance"

test_endpoint "GET" "/api/ethHelpers?address=0x742d35Cc6634C0532925a3b8D162Be00C9B2A26F&method=votes" "Get Ethereum votes"

test_endpoint "GET" "/api/ethHelpers?address=0x742d35Cc6634C0532925a3b8D162Be00C9B2A26F&method=skatehiveNFTBalance" "Get Skatehive NFT balance"

test_endpoint "GET" "/api/leaderboard" "Fetch and store leaderboard data"

test_endpoint "GET" "/api/leaderboard?community=hive-173115" "Fetch leaderboard for specific community"

test_endpoint "POST" "/api/leaderboard" "Store leaderboard data via POST"

# V1 Profile endpoints
test_endpoint "GET" "/api/v1/profile/web3warrior" "Get V1 user profile"

# V1 Balance endpoints  
test_endpoint "GET" "/api/v1/balance/web3warrior" "Get V1 user balance"

# V1 Feed endpoints
test_endpoint "GET" "/api/v1/feed" "Get V1 general feed"
test_endpoint "GET" "/api/v1/feed/trending" "Get V1 trending feed"
test_endpoint "GET" "/api/v1/feed/web3warrior" "Get V1 user feed"

# V1 Social endpoints
test_endpoint "GET" "/api/v1/followers/web3warrior" "Get V1 user followers"
test_endpoint "GET" "/api/v1/following/web3warrior" "Get V1 user following"

# V1 Comments
test_endpoint "GET" "/api/v1/comments" "Get V1 comments"

# V1 Market
test_endpoint "GET" "/api/v1/market" "Get V1 market data"

echo -e "${GREEN}🚀 V2 CORE ENDPOINTS${NC}"
echo "===================="

# V2 Core Endpoints
test_endpoint "GET" "/api/v2" "V2 API overview and available endpoints"

test_endpoint "GET" "/api/v2/leaderboard" "Get V2 leaderboard data"

echo -e "${GREEN}👤 V2 SOCIAL ENDPOINTS${NC}"
echo "======================"

# V2 Profile Endpoints
test_endpoint "GET" "/api/v2/profile" "Get all profiles"

test_endpoint "GET" "/api/v2/profile/web3warrior" "Get specific user profile"

# V2 Social Endpoints
test_endpoint "GET" "/api/v2/followers/web3warrior?username=web3warrior" "Get user followers"

test_endpoint "GET" "/api/v2/following/web3warrior?username=web3warrior" "Get users following"

echo -e "${GREEN}📰 V2 FEED ENDPOINTS${NC}"
echo "===================="

# V2 Feed Endpoints
test_endpoint "GET" "/api/v2/feed" "Get general feed"

test_endpoint "GET" "/api/v2/feed?page=1&limit=10" "Get general feed with pagination"

test_endpoint "GET" "/api/v2/feed/web3warrior?username=web3warrior" "Get user-specific feed"

test_endpoint "GET" "/api/v2/feed/trending" "Get trending posts feed"

echo -e "${GREEN}📄 V2 POST ENDPOINT${NC}"
echo "===================="

# V2 Single Post Endpoint (edge-cached; HAFSQL + soft-post de-alias, shape matches feed items)
# Sample author/permlink — update if it returns 404 (content may age out of queries).
test_endpoint "GET" "/api/v2/post/xvlad/sh-20260703t042512" "Get a single post by author/permlink"

test_endpoint "GET" "/api/v2/post/skatehive/this-permlink-does-not-exist-zzz" "Single post 404 (nonexistent permlink)"

echo -e "${GREEN}💰 V2 WALLET ENDPOINTS${NC}"
echo "======================"

# V2 Wallet Endpoints
test_endpoint "GET" "/api/v2/balance/web3warrior?username=web3warrior" "Get user balance information"

echo -e "${GREEN}📸 V2 SKATESNAPS ENDPOINTS${NC}"
echo "=========================="

# V2 SkateSnaps Endpoints
test_endpoint "GET" "/api/v2/skatesnaps" "Get all skate snaps"

test_endpoint "GET" "/api/v2/skatesnaps?page=1&limit=5" "Get skate snaps with pagination"

test_endpoint "GET" "/api/v2/skatesnaps/web3warrior?username=web3warrior" "Get user-specific skate snaps"

test_endpoint "GET" "/api/v2/skatesnaps/trending" "Get trending skate snaps"

echo -e "${GREEN}🔧 V2 UTILITY ENDPOINTS${NC}"
echo "======================="

# V2 Utility Endpoints
test_endpoint "GET" "/api/v2/comments" "Get comments"

test_endpoint "GET" "/api/v2/comments?page=1&limit=5" "Get comments with pagination"

test_endpoint "GET" "/api/v2/market" "Get market data"

test_endpoint "GET" "/api/v2/skatespots" "Get skate spots information"

test_endpoint "GET" "/api/v2/skatespots?location=california" "Get skate spots by location"

echo -e "${GREEN}🔄 CRON & MAINTENANCE ENDPOINTS${NC}"
echo "==============================="

# Cron endpoints (these might be protected)
test_endpoint "GET" "/api/cron/update" "Trigger data update"

test_endpoint "GET" "/api/cron/v2" "V2 cron overview"

test_endpoint "GET" "/api/cron/v2/leaderboard" "Update V2 leaderboard data"

echo -e "${GREEN}🧪 INTERNAL/DEV ENDPOINTS${NC}"
echo "========================="

# Internal endpoints (might be for development)
test_endpoint "GET" "/api/v2/__feed_old" "Old feed implementation"

test_endpoint "GET" "/api/v2/__magazine" "Magazine endpoint"

test_endpoint "GET" "/api/v2/__trending" "Trending implementation"

test_endpoint "GET" "/api/v2/__skatefeed" "Skate feed implementation"

test_endpoint "GET" "/api/v2/__fullprofile/web3warrior" "Full profile data"

test_endpoint "GET" "/api/v2/__wallet/web3warrior" "Full wallet data"

echo ""
echo -e "${GREEN}✅ TESTING COMPLETE!${NC}"
echo "====================="
echo ""
echo "📋 NEXT STEPS:"
echo "1. Review the status codes and responses above"
echo "2. Note which endpoints return 200 (working) vs 500/404 (issues)"
echo "3. Create README files for working endpoints"
echo "4. Fix any broken endpoints found"
echo ""
echo "💡 TIP: Look for 'Status: 200' to identify working endpoints"
echo "❌ Watch for 'Status: 500' or 'Status: 404' for broken ones"
