from web3 import Web3

rpc_node='https://mainnet.infura.io/v3/340ab19d3ab14fcea1d94fb2adde170b' 
w3 = Web3(Web3.HTTPProvider(rpc_node))

account = "0xEeC84548aAd50A465963bB501e39160c58366692"

def get_balance(address):
    return w3.eth.get_balance(Web3.to_checksum_address(address))

print(f"Balance for {account}:")
print(get_balance(account))