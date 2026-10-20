/*
  ======================================================================
  Weather Detector - Arduino UNO R4 WiFi sensor node
  ======================================================================
  The Arduino is a Wi-Fi CLIENT only. It joins the phone hotspot, reads the
  sensors once per second and PUSHES a JSON reading to the PC with an
  HTTP POST. It runs no web server and no access point.

  Sensors / pins
    Rain sensor  analog out  -> A0
    MQ-2 gas     analog out  -> A1
    DHT11        data        -> A2   (10k pull-up DATA->VCC if bare sensor)
    BMP180       SDA / SCL   -> I2C (SDA / SCL header pins, or A4 / A5)
                 VCC -> 3.3V, GND -> GND

  Libraries (Arduino IDE -> Library Manager)
    - WiFiS3                     (ships with the "Arduino UNO R4 Boards" package)
    - DHT sensor library         (Adafruit)
    - Adafruit Unified Sensor    (Adafruit, required by the DHT library)
    - Adafruit BMP085 Library    (Adafruit, also supports the BMP180)

  Board: Tools -> Board -> Arduino UNO R4 Boards -> Arduino UNO R4 WiFi
  Serial Monitor: 115200 baud
  ======================================================================
*/

#include <WiFiS3.h>
#include <Wire.h>
#include <DHT.h>
#include <Adafruit_BMP085.h>

// ======================================================================
//  USER SETTINGS  -  edit these
// ======================================================================

// Phone hotspot (must be 2.4 GHz; the UNO R4 WiFi cannot join 5 GHz)

// WHEN THIS CHANGE, RUN IPCONFIG ON THE CMD
const char WIFI_SSID[] = "POCO X8 Pro";
const char WIFI_PASS[] = "papamoko";

// PC running XAMPP (the static IP you set on the PC) and the PHP endpoint
const char     SERVER_IP[]     = "10.77.53.233"; // <--- THIS WILL ALSO CHANGE WHEN YOU CHANGE YOUR WIFI 
const uint16_t SERVER_PORT     = 80;
const char     ENDPOINT_PATH[] = "/weather_detector/receive_data.php";

// Must match API_KEY in web/weather_detector/config.php.
// Use "" (empty) only if you also set API_KEY to '' in config.php.
const char API_KEY[] = "Delucios2004";

// Name sent in every reading (shows up in the PHP validation / logs)
const char DEVICE_NAME[] = "uno-r4-weather-01";

// Sea-level reference pressure in Pascals, used to compute altitude.
// 101325 = standard atmosphere. For better altitude accuracy, use today's
// local sea-level pressure (hPa x 100) from a weather service.
const float SEA_LEVEL_PA = 101325.0f;

// ======================================================================
//  PINS AND TIMING  -  normally left alone
// ======================================================================

const uint8_t PIN_RAIN = A0;
const uint8_t PIN_GAS  = A1;
const uint8_t PIN_DHT  = A2;
#define DHT_TYPE DHT11

const uint8_t ADC_BITS = 12;                 // raw ADC range 0..4095

const unsigned long SEND_INTERVAL_MS = 1000; // one reading + POST per second
const unsigned long WIFI_RETRY_MS    = 10000;// minimum gap between Wi-Fi join attempts
const unsigned long HTTP_TIMEOUT_MS  = 3000; // max wait for the server's reply
const unsigned long BMP_RETRY_MS     = 30000;// how often to re-probe a missing BMP180

// ======================================================================
//  GLOBALS
// ======================================================================

DHT dht(PIN_DHT, DHT_TYPE);
Adafruit_BMP085 bmp;
IPAddress serverIp;

struct Reading {
  float temperatureC;
  float humidityPct;
  int   rainRaw;
  int   gasRaw;
  float pressureHpa;
  float altitudeM;
  bool  bmp180Available;
};

bool          wifiModuleOk     = true;
bool          wifiAttempted    = false;
unsigned long lastWifiAttempt  = 0;
unsigned long lastCycle        = 0;
unsigned long lastBmpTry       = 0;
bool          bmpOk            = false;
bool          haveDht          = false;
float         lastGoodTemp     = 0.0f;
float         lastGoodHum      = 0.0f;
unsigned long okCount          = 0;
unsigned long failCount        = 0;
unsigned long consecutiveFails = 0;

// ======================================================================
//  WI-FI
// ======================================================================

/*
  Make sure we are on the hotspot. Returns true when connected.
  A join attempt takes up to ~10 s (done inside WiFi.begin), so attempts are
  rate-limited to one per WIFI_RETRY_MS; in between, the sketch keeps reading
  sensors and simply skips the POST.
*/
bool ensureWiFi() {
  if (!wifiModuleOk) return false;
  if (WiFi.status() == WL_CONNECTED) return true;

  unsigned long now = millis();
  if (wifiAttempted && (now - lastWifiAttempt) < WIFI_RETRY_MS) return false;

  wifiAttempted   = true;
  lastWifiAttempt = now;

  Serial.print("[wifi] joining \"");
  Serial.print(WIFI_SSID);
  Serial.println("\" ...");

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);   // blocks until joined or timed out

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[wifi] connected, Arduino IP = ");
    Serial.print(WiFi.localIP());
    Serial.print(", RSSI = ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    return true;
  }

  Serial.println("[wifi] join failed. Check SSID/password and that the hotspot is on 2.4 GHz. Will retry.");
  return false;
}

// ======================================================================
//  SENSORS
// ======================================================================

/*
  Fills 'r'. Returns false only if no valid DHT11 reading has ever been
  obtained (so there is nothing sensible to send yet).
  A failed DHT11 read re-uses the last good value instead of sending NaN.
*/
bool readSensors(Reading &r) {
  // DHT11 (the library caches results for 2 s, so calling every 1 s is safe)
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    lastGoodTemp = t;
    lastGoodHum  = h;
    haveDht      = true;
  } else {
    Serial.println("[dht] read failed - check wiring on A2; using last good value");
  }
  r.temperatureC = lastGoodTemp;
  r.humidityPct  = lastGoodHum;

  // Analog sensors (raw ADC counts)
  r.rainRaw = analogRead(PIN_RAIN);
  r.gasRaw  = analogRead(PIN_GAS);

  // BMP180: probe again every BMP_RETRY_MS if it was missing
  if (!bmpOk && (millis() - lastBmpTry) >= BMP_RETRY_MS) {
    lastBmpTry = millis();
    bmpOk = bmp.begin();
    if (bmpOk) Serial.println("[bmp180] detected");
  }

  r.pressureHpa     = 0.0f;
  r.altitudeM       = 0.0f;
  r.bmp180Available = false;

  if (bmpOk) {
    float pHpa = bmp.readPressure() / 100.0f;
    // A BMP180 that was unplugged returns nonsense; treat that as "not available".
    if (pHpa > 300.0f && pHpa < 1100.0f) {
      r.pressureHpa     = pHpa;
      r.altitudeM       = bmp.readAltitude(SEA_LEVEL_PA);
      r.bmp180Available = true;
    } else {
      Serial.println("[bmp180] implausible pressure - sensor lost?");
      bmpOk = false;
    }
  }

  return haveDht;
}

// ======================================================================
//  JSON + HTTP POST
// ======================================================================

String buildJson(const Reading &r) {
  String j;
  j.reserve(256);
  j += "{\"device\":\"";           j += DEVICE_NAME;                         j += "\"";
  j += ",\"temperatureC\":";      j += String(r.temperatureC, 2);
  j += ",\"humidityPct\":";       j += String(r.humidityPct, 2);
  j += ",\"rainRaw\":";           j += String(r.rainRaw);
  j += ",\"gasRaw\":";            j += String(r.gasRaw);
  j += ",\"pressureHpa\":";       j += String(r.pressureHpa, 2);
  j += ",\"altitudeM\":";         j += String(r.altitudeM, 2);
  j += ",\"bmp180Available\":";   j += (r.bmp180Available ? "true" : "false");
  j += ",\"uptimeSeconds\":";     j += String(millis() / 1000UL);
  j += "}";
  return j;
}

/*
  Sends one reading. Returns true if the server answered 2xx.
  Never blocks longer than the connect time plus HTTP_TIMEOUT_MS.
*/
bool postReading(const Reading &r) {
  String body = buildJson(r);

  WiFiClient client;
  if (!client.connect(serverIp, SERVER_PORT)) {
    Serial.println("[http] cannot connect to the PC (is Apache running? firewall? correct IP?)");
    return false;
  }

  String req;
  req.reserve(body.length() + 256);
  req += "POST ";            req += ENDPOINT_PATH;           req += " HTTP/1.1\r\n";
  req += "Host: ";           req += SERVER_IP;               req += "\r\n";
  req += "User-Agent: UNO-R4-WiFi\r\n";
  req += "Content-Type: application/json\r\n";
  if (strlen(API_KEY) > 0) {
    req += "X-API-Key: ";    req += API_KEY;                 req += "\r\n";
  }
  req += "Content-Length: "; req += String((unsigned int)body.length()); req += "\r\n";
  req += "Connection: close\r\n\r\n";
  req += body;

  client.print(req);

  // Read the beginning of the reply (status line + a little of the JSON body)
  String resp;
  resp.reserve(512);
  unsigned long start = millis();
  while ((millis() - start) < HTTP_TIMEOUT_MS && resp.length() < 512) {
    while (client.available() && resp.length() < 512) {
      resp += (char)client.read();
    }
    if (!client.connected() && !client.available()) break;
    delay(2);
  }
  client.stop();

  if (resp.length() < 12) {
    Serial.println("[http] no reply from server (timeout)");
    return false;
  }

  int code = resp.substring(9, 12).toInt();   // "HTTP/1.1 200 OK" -> 200
  bool ok = (code >= 200 && code < 300);

  if (ok) {
    Serial.print("[http] POST ok (");
    Serial.print(code);
    Serial.println(")");
  } else {
    Serial.print("[http] server rejected the reading, HTTP ");
    Serial.println(code);
    int bodyStart = resp.indexOf("\r\n\r\n");
    if (bodyStart >= 0) {
      Serial.print("       reply: ");
      Serial.println(resp.substring(bodyStart + 4));
    }
    if (code == 401) Serial.println("       -> API_KEY here does not match config.php");
    if (code == 404) Serial.println("       -> wrong ENDPOINT_PATH");
  }
  return ok;
}

// ======================================================================
//  ARDUINO ENTRY POINTS
// ======================================================================

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0) < 3000) { /* wait briefly for the Serial Monitor */ }

  Serial.println();
  Serial.println("=== Weather Detector - UNO R4 WiFi ===");

  analogReadResolution(ADC_BITS);

  dht.begin();
  bmpOk = bmp.begin();
  lastBmpTry = millis();
  Serial.println(bmpOk ? "[bmp180] detected" : "[bmp180] NOT found (check SDA/SCL and 3.3V) - will keep retrying");

  if (!serverIp.fromString(SERVER_IP)) {
    Serial.print("[config] SERVER_IP is not a valid IPv4 address: ");
    Serial.println(SERVER_IP);
  }

  if (WiFi.status() == WL_NO_MODULE) {
    Serial.println("[wifi] communication with the Wi-Fi module failed");
    wifiModuleOk = false;
  } else {
    String fv = WiFi.firmwareVersion();
    Serial.print("[wifi] module firmware ");
    Serial.println(fv);
    if (fv < WIFI_FIRMWARE_LATEST_VERSION) {
      Serial.print("[wifi] a newer firmware exists: ");
      Serial.println(WIFI_FIRMWARE_LATEST_VERSION);
    }
  }

  delay(1000);                       // DHT11 needs ~1 s after power-up
  ensureWiFi();
  lastCycle = millis() - SEND_INTERVAL_MS;   // run the first cycle immediately
}

void loop() {
  unsigned long now = millis();
  if ((now - lastCycle) < SEND_INTERVAL_MS) return;
  lastCycle = now;

  Reading r;
  bool haveData = readSensors(r);

  Serial.print("[read] T=");   Serial.print(r.temperatureC, 1);
  Serial.print("C H=");        Serial.print(r.humidityPct, 1);
  Serial.print("% rain=");     Serial.print(r.rainRaw);
  Serial.print(" gas=");       Serial.print(r.gasRaw);
  if (r.bmp180Available) {
    Serial.print(" P=");       Serial.print(r.pressureHpa, 1);
    Serial.print("hPa alt=");  Serial.print(r.altitudeM, 1);
    Serial.println("m");
  } else {
    Serial.println(" P/alt=n/a");
  }

  if (!haveData) {
    Serial.println("[skip] no valid DHT11 reading yet, nothing to send");
    return;
  }

  if (!ensureWiFi()) {
    Serial.println("[skip] Wi-Fi is down, will retry");
    return;
  }

  if (postReading(r)) {
    okCount++;
    consecutiveFails = 0;
  } else {
    failCount++;
    consecutiveFails++;
    Serial.print("[stats] sent=");      Serial.print(okCount);
    Serial.print(" failed=");           Serial.print(failCount);
    Serial.print(" in a row=");         Serial.println(consecutiveFails);
  }
}
