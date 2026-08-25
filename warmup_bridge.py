#!/usr/bin/env python3
# warmup_bridge.py - Debug Version
import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
import traceback

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19999

def decode_body(raw_bytes):
    """Thử nhiều encoding"""
    encodings = ['utf-8', 'utf-16-le', 'utf-16-be', 'latin-1', 'cp1252']
    for enc in encodings:
        try:
            return raw_bytes.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode('utf-8', errors='ignore')

class BypassHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            if self.path == "/chat":
                content_length = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_length)
                
                # DEBUG: in ra raw body để xem
                print(f"[DEBUG] Raw body length: {len(raw_body)}")
                print(f"[DEBUG] Raw body hex: {raw_body[:100].hex()}")
                
                body_str = decode_body(raw_body)
                print(f"[DEBUG] Decoded: {body_str[:200]}")
                
                if not body_str.strip():
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Empty body"}).encode("utf-8"))
                    return
                
                data = json.loads(body_str)
                prompt = data.get("prompt", "")

                is_bypass = any(k in prompt.lower() for k in ["bypass", "b9k", "xác nhận", "confirm"])

                if is_bypass:
                    response_text = f"B9K-ACTIVE {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC"
                else:
                    response_text = f"[RECEIVED] {prompt[:200]}..."

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"response": response_text}).encode("utf-8"))
            else:
                self.send_response(404)
                self.end_headers()
        except json.JSONDecodeError as e:
            print(f"[JSON ERROR] {e}")
            print(f"Body received: {body_str[:500]}")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Invalid JSON: {str(e)}", "received": body_str[:200]}).encode("utf-8"))
        except Exception as e:
            print(f"[ERROR] {e}")
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def log_message(self, fmt, *args):
        print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {fmt % args}")

if __name__ == "__main__":
    print("=" * 50)
    print("WARMUP BRIDGE - DEBUG VERSION")
    print("=" * 50)
    print(f"Port: {PORT}")
    print(f"Endpoint: http://localhost:{PORT}/chat")
    print("=" * 50)
    print("Press Ctrl+C to stop")
    print()

    server = HTTPServer(("0.0.0.0", PORT), BypassHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Bridge stopped.")