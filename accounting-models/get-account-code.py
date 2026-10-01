from web3 import Web3

rpc_node='https://mainnet.infura.io/v3/340ab19d3ab14fcea1d94fb2adde170b'
w3 = Web3(Web3.HTTPProvider(rpc_node))

account = "0xEeC84548aAd50A465963bB501e39160c58366692"

def get_code(address):
    return w3.eth.get_code(Web3.to_checksum_address(address))

code = get_code(account)
print(f"Code at {account} ({len(code)} bytes):")
print(w3.to_hex(code[:32]))
