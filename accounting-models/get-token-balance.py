from web3 import Web3

rpc_node='https://mainnet.infura.io/v3/340ab19d3ab14fcea1d94fb2adde170b'
w3 = Web3(Web3.HTTPProvider(rpc_node))

token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  # USDC
account = "0x28C6c06298d514Db089934071355E5743bf21d60"

# Minimal ABI: only the two ERC-20 functions we need
abi = [
    {"name": "balanceOf", "type": "function",
     "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "decimals", "type": "function",
     "stateMutability": "view",
     "inputs": [],
     "outputs": [{"name": "", "type": "uint8"}]},
]
contract = w3.eth.contract(address=token, abi=abi)

owner = Web3.to_checksum_address(account)
balance = contract.functions.balanceOf(owner).call()
decimals = contract.functions.decimals().call()

print(f"Token balance for {account}:")
print(f"{balance} (decimals: {decimals})")
