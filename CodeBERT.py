from flask import Flask, request, jsonify
from transformers import AutoTokenizer, AutoModel
import torch

app = Flask(__name__)

model_name = "microsoft/codebert-base"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModel.from_pretrained(model_name)

def codebert_embed_batch(texts):
    inputs = tokenizer(texts, return_tensors="pt", truncation=True, padding=True, max_length=512)
    with torch.no_grad():
        outputs = model(**inputs)
    # Use [CLS] token (first token) from each input sequence
    cls_embeddings = outputs.last_hidden_state[:, 0, :]
    return cls_embeddings.numpy().tolist()

@app.route("/embed", methods=["POST"])
def embed():
    data = request.get_json()
    texts = data.get("texts", [])
    if not texts or not isinstance(texts, list):
        return jsonify({"error": "No texts provided or wrong format"}), 400

    embeddings = codebert_embed_batch(texts)
    return jsonify({"embeddings": embeddings})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
