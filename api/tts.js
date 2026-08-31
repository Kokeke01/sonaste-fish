// ============================================
// /api/tts.js - Endpoint de Text-to-Speech con Fish Audio
// ============================================

import NodeCache from 'node-cache';
import crypto from 'crypto';

// ============================================
// CONFIGURACIÓN DE CACHE
// ============================================
const audioCache = new NodeCache({
    stdTTL: 3600, // 1 hora
    checkperiod: 600,
    maxKeys: 100,
});

// ============================================
// FUNCIÓN PARA GENERAR CACHE KEY
// ============================================
function generateCacheKey(text, modelId) {
    const hash = crypto.createHash('sha256');
    hash.update(`${text}:${modelId}`);
    return hash.digest('hex');
}

// ============================================
// FUNCIÓN PARA SANITIZAR TEXTO
// ============================================
function sanitizeText(text) {
    // Eliminar caracteres no deseados
    return text
        .replace(/[<>]/g, '') // Prevenir inyección
        .replace(/\s+/g, ' ') // Espacios múltiples a uno
        .trim();
}

// ============================================
// HANDLER PRINCIPAL
// ============================================
export default async function handler(req, res) {
    // ============================================
    // 1. VALIDACIÓN DE MÉTODO
    // ============================================
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            error: 'Método no permitido. Usa POST.',
            allowedMethods: ['POST']
        });
    }

    // ============================================
    // 2. VALIDACIÓN DE PARÁMETROS
    // ============================================
    const { text, modelId } = req.body;

    if (!text || !modelId) {
        return res.status(400).json({ 
            error: 'Faltan parámetros: "text" y "modelId" son requeridos',
            required: ['text (string)', 'modelId (string)'],
            received: { text: !!text, modelId: !!modelId }
        });
    }

    // Validar tipo de datos
    if (typeof text !== 'string' || typeof modelId !== 'string') {
        return res.status(400).json({ 
            error: 'Los parámetros deben ser strings',
            types: { text: typeof text, modelId: typeof modelId }
        });
    }

    // Sanitizar texto
    const sanitizedText = sanitizeText(text);

    // Validar texto vacío después de sanitizar
    if (sanitizedText.length === 0) {
        return res.status(400).json({ 
            error: 'El texto no puede estar vacío o contener solo espacios'
        });
    }

    // Validar longitud del texto
    const MAX_TEXT_LENGTH = 2000;
    if (sanitizedText.length > MAX_TEXT_LENGTH) {
        return res.status(400).json({ 
            error: `El texto es demasiado largo. Máximo ${MAX_TEXT_LENGTH} caracteres.`,
            currentLength: sanitizedText.length,
            maxLength: MAX_TEXT_LENGTH
        });
    }

    // Validar modelo ID (que no sea vacío)
    if (modelId.trim().length === 0) {
        return res.status(400).json({ 
            error: 'El modelId no puede estar vacío'
        });
    }

    // ============================================
    // 3. VALIDACIÓN DE API KEY
    // ============================================
    const apiKey = process.env.FISH_AUDIO_API_KEY;
    
    if (!apiKey) {
        console.error('❌ FISH_AUDIO_API_KEY no está configurada en el entorno');
        return res.status(500).json({ 
            error: 'Error de configuración del servidor',
            code: 'CONFIG_ERROR'
        });
    }

    // ============================================
    // 4. CHECK DE CACHE
    // ============================================
    const cacheKey = generateCacheKey(sanitizedText, modelId);
    const cachedAudio = audioCache.get(cacheKey);

    if (cachedAudio) {
        console.log(`✅ Audio servido desde cache: ${cacheKey.substring(0, 10)}...`);
        console.log(`📊 Tamaño en cache: ${(cachedAudio.length / 1024).toFixed(2)} KB`);
        
        // Enviar audio desde cache
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', cachedAudio.length);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey.substring(0, 10));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        return res.status(200).send(Buffer.from(cachedAudio));
    }

    // ============================================
    // 5. CONFIGURACIÓN DE TIMEOUT
    // ============================================
    const TIMEOUT_MS = 30000; // 30 segundos
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        console.log(`🎤 Generando audio para modelo: ${modelId}`);
        console.log(`📝 Texto: "${sanitizedText.substring(0, 100)}${sanitizedText.length > 100 ? '...' : ''}"`);
        console.log(`📏 Longitud: ${sanitizedText.length} caracteres`);

        // ============================================
        // 6. LLAMADA A FISH AUDIO
        // ============================================
        const startTime = Date.now();
        
        const response = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'audio/mpeg',
                'User-Agent': 'SONASTE-App/1.0',
            },
            body: JSON.stringify({
                text: sanitizedText,
                model_id: modelId,
                format: 'mp3',
                // Parámetros opcionales para mejorar la calidad
                speed: 1.0,
                pitch: 0,
                emotion: 'neutral',
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // ============================================
        // 7. MANEJO DE ERRORES DE FISH AUDIO
        // ============================================
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Error de Fish Audio (${response.status}): ${errorText}`);
            
            let errorMessage = `Error en Fish Audio: ${response.status}`;
            let errorCode = 'FISH_AUDIO_ERROR';
            
            try {
                const errorData = JSON.parse(errorText);
                if (errorData.message) {
                    errorMessage = errorData.message;
                } else if (errorData.error) {
                    errorMessage = errorData.error;
                }
                if (errorData.code) errorCode = errorData.code;
            } catch {
                if (errorText && errorText.length < 200) {
                    errorMessage = errorText;
                }
            }

            // Errores comunes de Fish Audio con mensajes amigables
            const statusMessages = {
                400: 'Solicitud inválida. Verifica el texto y el modelo.',
                401: 'API Key inválida o expirada. Contacta al administrador.',
                402: 'Créditos insuficientes en Fish Audio. Contacta al administrador.',
                404: 'Modelo no encontrado. Verifica el ID del modelo.',
                429: 'Demasiadas solicitudes. Espera un momento e intenta nuevamente.',
                500: 'Error interno en Fish Audio. Intenta más tarde.',
                503: 'Servicio de Fish Audio no disponible. Intenta más tarde.',
            };

            const userMessage = statusMessages[response.status] || errorMessage;

            return res.status(response.status).json({ 
                error: userMessage,
                code: errorCode,
                status: response.status,
                details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
            });
        }

        // ============================================
        // 8. PROCESAR RESPUESTA
        // ============================================
        const audioBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(audioBuffer);
        
        // Verificar que el audio no esté vacío
        if (buffer.length === 0) {
            throw new Error('El audio generado está vacío');
        }

        // Verificar que sea un archivo de audio válido
        // Los MP3 comienzan con 0xFF 0xFB o 0xFF 0xFA o 0xFF 0xF3 o 0xFF 0xF2
        // o 0xFF 0xE0-0xFF 0xEF (MPEG-1)
        const isAudioFile = buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0;
        if (!isAudioFile) {
            console.warn('⚠️ El archivo generado podría no ser MP3 válido. Primeros bytes:', 
                buffer.slice(0, 4).toString('hex'));
        }

        // ============================================
        // 9. GUARDAR EN CACHE
        // ============================================
        audioCache.set(cacheKey, buffer);
        console.log(`💾 Audio cacheado: ${cacheKey.substring(0, 10)}...`);
        console.log(`📊 Tamaño en cache: ${(buffer.length / 1024).toFixed(2)} KB`);

        // ============================================
        // 10. REGISTRAR MÉTRICAS
        // ============================================
        const duration = Date.now() - startTime;
        const sizeKB = (buffer.length / 1024).toFixed(2);
        
        console.log(`✅ Audio generado exitosamente en ${duration}ms`);
        console.log(`📊 Tamaño: ${sizeKB} KB`);
        console.log(`📊 Velocidad: ${(sanitizedText.length / (duration / 1000)).toFixed(1)} caracteres/segundo`);

        // ============================================
        // 11. ENVIAR RESPUESTA
        // ============================================
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('X-Generation-Time', `${duration}ms`);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Key', cacheKey.substring(0, 10));
        res.setHeader('X-Text-Length', sanitizedText.length);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        return res.status(200).send(buffer);

    } catch (error) {
        clearTimeout(timeoutId);
        
        // ============================================
        // 12. MANEJO DE ERRORES ESPECÍFICOS
        // ============================================
        console.error('❌ Error al generar audio:', error);

        // Error de timeout
        if (error.name === 'AbortError') {
            console.error('⏱️ Timeout alcanzado');
            return res.status(504).json({ 
                error: 'Tiempo de espera agotado. El servidor tardó demasiado en responder.',
                code: 'TIMEOUT_ERROR',
                timeout: TIMEOUT_MS
            });
        }

        // Error de red
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            console.error('🔌 Error de conexión:', error.code);
            return res.status(503).json({ 
                error: 'No se pudo conectar con el servicio de Fish Audio. Verifica tu conexión a internet.',
                code: 'CONNECTION_ERROR',
                details: error.code
            });
        }

        // Error de certificado SSL
        if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            console.error('🔒 Error de certificado SSL');
            return res.status(503).json({ 
                error: 'Error de seguridad al conectar con Fish Audio.',
                code: 'SSL_ERROR'
            });
        }

        // Error de tamaño de respuesta
        if (error.message.includes('too large')) {
            return res.status(413).json({ 
                error: 'El audio generado es demasiado grande.',
                code: 'PAYLOAD_TOO_LARGE'
            });
        }

        // Error general
        const errorResponse = {
            error: 'Error interno del servidor al generar el audio',
            code: 'INTERNAL_ERROR',
        };

        // Solo mostrar detalles en desarrollo
        if (process.env.NODE_ENV === 'development') {
            errorResponse.message = error.message;
            errorResponse.stack = error.stack;
        }

        return res.status(500).json(errorResponse);
    }
}

// ============================================
// 13. MANEJO DE CORS PARA PREFLIGHT
// ============================================
export async function handleOptions(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 horas
        return res.status(204).end();
    }
}

// ============================================
// 14. ENDPOINT DE ESTADÍSTICAS (OPCIONAL)
// ============================================
export async function statsHandler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        const keys = audioCache.keys();
        const stats = audioCache.getStats();
        
        // Calcular uso de memoria aproximado
        let totalSize = 0;
        const cacheDetails = [];
        
        for (const key of keys) {
            const value = audioCache.get(key);
            if (value) {
                const size = value.length || 0;
                totalSize += size;
                cacheDetails.push({
                    key: key.substring(0, 10) + '...',
                    sizeKB: (size / 1024).toFixed(2),
                    age: Math.floor((Date.now() - audioCache.getTtl(key)) / 1000),
                });
            }
        }

        return res.status(200).json({
            cache: {
                totalKeys: keys.length,
                maxKeys: 100,
                totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
                hits: stats.hits || 0,
                misses: stats.misses || 0,
                hitRatio: stats.hits + stats.misses > 0 
                    ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + '%'
                    : '0%',
                details: cacheDetails.slice(0, 20), // Mostrar solo los 20 primeros
            },
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            nodeVersion: process.version,
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        return res.status(500).json({ 
            error: 'Error al obtener estadísticas',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}

// ============================================
// 15. ENDPOINT PARA LIMPIAR CACHE (ADMIN)
// ============================================
export async function clearCacheHandler(req, res) {
    if (req.method !== 'DELETE') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    // Solo permitir en desarrollo o con token secreto
    const isDevelopment = process.env.NODE_ENV === 'development';
    const secretToken = process.env.CACHE_SECRET_TOKEN;
    const providedToken = req.headers['x-cache-token'];

    if (!isDevelopment && (!secretToken || providedToken !== secretToken)) {
        return res.status(401).json({ 
            error: 'No autorizado para limpiar cache' 
        });
    }

    try {
        const keys = audioCache.keys();
        const count = keys.length;
        
        // Limpiar cache
        audioCache.flushAll();
        
        console.log(`🧹 Cache limpiado: ${count} entradas eliminadas`);
        
        return res.status(200).json({
            success: true,
            message: `Cache limpiado exitosamente`,
            deleted: count,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        return res.status(500).json({ 
            error: 'Error al limpiar cache',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}