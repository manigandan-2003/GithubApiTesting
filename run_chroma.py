# import chromadb

# chroma_client = chromadb.PersistentClient(path="\chroma-data")
# print("ChromaDB server is running at ./chroma-data")

import chromadb

chroma_server = chromadb.HttpServer(host="127.0.0.1", port=8000, settings={"persist_directory": "./chroma-data"})
chroma_server.start()
