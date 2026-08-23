import http.server
import ssl
import sqlite3
import json
from datetime import datetime
import os

DB_PATH = 'cuentaclara.db'

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Tabla de visitas/usuarios
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_uuid TEXT,
            ip TEXT,
            user_agent TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Tabla de escaneos/acciones
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_uuid TEXT,
            action_type TEXT,
            price REAL,
            currency TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

class SecureAPIRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Habilitar CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/visit':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                user_uuid = data.get('uuid')
                ip = self.client_address[0]
                user_agent = self.headers.get('User-Agent', '')

                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute(
                    'INSERT INTO visits (user_uuid, ip, user_agent) VALUES (?, ?, ?)',
                    (user_uuid, ip, user_agent)
                )
                conn.commit()
                conn.close()

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))
            return

        elif self.path == '/api/scan':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                user_uuid = data.get('uuid')
                action_type = data.get('action', 'scan')  # 'scan' o 'add_to_cart'
                price = data.get('price', 0.0)
                currency = data.get('currency', 'USD')

                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute(
                    'INSERT INTO scans (user_uuid, action_type, price, currency) VALUES (?, ?, ?, ?)',
                    (user_uuid, action_type, price, currency)
                )
                conn.commit()
                conn.close()

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))
            return

        super().do_POST()

    def do_GET(self):
        if self.path == '/api/stats':
            try:
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()

                # Visitas totales
                cursor.execute('SELECT COUNT(*) FROM visits')
                total_visits = cursor.fetchone()[0]

                # Usuarios únicos (UUIDs distintos)
                cursor.execute('SELECT COUNT(DISTINCT user_uuid) FROM visits')
                unique_users = cursor.fetchone()[0]

                # Escaneos totales
                cursor.execute("SELECT COUNT(*) FROM scans WHERE action_type = 'scan'")
                total_scans = cursor.fetchone()[0]

                # Artículos añadidos
                cursor.execute("SELECT COUNT(*) FROM scans WHERE action_type = 'add_to_cart'")
                total_added = cursor.fetchone()[0]

                # Últimas 10 visitas con hora
                cursor.execute('SELECT user_uuid, ip, timestamp FROM visits ORDER BY timestamp DESC LIMIT 10')
                recent_visits = [{"uuid": r[0][:8] + "...", "ip": r[1], "time": r[2]} for r in cursor.fetchall()]

                conn.close()

                stats = {
                    "total_visits": total_visits,
                    "unique_users": unique_users,
                    "total_scans": total_scans,
                    "total_added": total_added,
                    "recent_visits": recent_visits
                }

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(stats).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))
            return

        super().do_GET()

if __name__ == '__main__':
    init_db()
    server_address = ('0.0.0.0', 8000)
    httpd = http.server.HTTPServer(server_address, SecureAPIRequestHandler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile="cert.pem", keyfile="key.pem")
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print("Servidor seguro HTTPS + Base de datos en ejecución en https://192.168.1.8:8000")
    httpd.serve_forever()
