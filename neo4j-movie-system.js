// ===== CONFIGURACIÓN DE NEO4J =====
const neo4j = require('neo4j-driver');

class Neo4jMovieRecommendationSystem {
    constructor() {
        // Configuración de la conexión a Neo4j
        this.driver = neo4j.driver(
            'bolt://localhost:7687', // URL de tu instancia Neo4j
            neo4j.auth.basic('neo4j', 'tu_password')
        );
        
        this.session = null;
        this.currentQuestion = null;
        this.questionPath = [];
        this.userId = this.generateUserId();
    }

    // ===== MÉTODOS DE CONEXIÓN =====
    async connect() {
        this.session = this.driver.session();
        await this.initializeDatabase();
    }

    async disconnect() {
        if (this.session) await this.session.close();
        await this.driver.close();
    }

    // ===== INICIALIZACIÓN DE LA BASE DE DATOS =====
    async initializeDatabase() {
        // Crear índices para optimizar consultas
        await this.session.run(`
            CREATE INDEX IF NOT EXISTS FOR (m:Movie) ON (m.title)
        `);
        
        await this.session.run(`
            CREATE INDEX IF NOT EXISTS FOR (g:Genre) ON (g.name)
        `);
        
        await this.session.run(`
            CREATE INDEX IF NOT EXISTS FOR (u:User) ON (u.id)
        `);

        // Poblar la base de datos con tus películas existentes
        await this.populateMovies();
        await this.populateQuestions();
    }

    // ===== POBLAR PELÍCULAS EN NEO4J =====
    async populateMovies() {
        const movies = this.getMoviesFromCurrentSystem();
        
        for (const [recommendationType, movie] of Object.entries(movies)) {
            await this.session.run(`
                MERGE (m:Movie {
                    title: $title,
                    recommendation_type: $recommendationType,
                    description: $description,
                    genre: $genre,
                    mood: $mood
                })
                MERGE (g:Genre {name: $genre})
                MERGE (mood:Mood {name: $mood})
                MERGE (m)-[:HAS_GENRE]->(g)
                MERGE (m)-[:HAS_MOOD]->(mood)
            `, {
                title: movie.title,
                recommendationType: recommendationType,
                description: movie.description,
                genre: movie.genre,
                mood: movie.mood
            });
        }
    }

    // ===== POBLAR PREGUNTAS EN NEO4J =====
    async populateQuestions() {
        const questions = this.getQuestionsFromCurrentSystem();
        
        for (const [questionId, question] of Object.entries(questions)) {
            // Crear nodo de pregunta
            await this.session.run(`
                MERGE (q:Question {
                    id: $id,
                    text: $text,
                    context: $context
                })
            `, {
                id: parseInt(questionId),
                text: question.text,
                context: question.context || ''
            });

            // Crear opciones y sus relaciones
            for (const option of question.options) {
                await this.session.run(`
                    MATCH (q:Question {id: $questionId})
                    MERGE (o:Option {
                        letter: $letter,
                        text: $text,
                        question_id: $questionId
                    })
                    MERGE (q)-[:HAS_OPTION]->(o)
                `, {
                    questionId: parseInt(questionId),
                    letter: option.letter,
                    text: option.text
                });

                // Conectar con siguiente pregunta o recomendación
                if (option.next) {
                    await this.session.run(`
                        MATCH (o:Option {letter: $letter, question_id: $questionId})
                        MATCH (nextQ:Question {id: $nextId})
                        MERGE (o)-[:LEADS_TO]->(nextQ)
                    `, {
                        letter: option.letter,
                        questionId: parseInt(questionId),
                        nextId: option.next
                    });
                }

                if (option.recommendation) {
                    await this.session.run(`
                        MATCH (o:Option {letter: $letter, question_id: $questionId})
                        MATCH (m:Movie {recommendation_type: $recommendationType})
                        MERGE (o)-[:RECOMMENDS]->(m)
                    `, {
                        letter: option.letter,
                        questionId: parseInt(questionId),
                        recommendationType: option.recommendation
                    });
                }
            }
        }
    }

    // ===== OBTENER PREGUNTA DESDE NEO4J =====
    async getQuestion(questionId) {
        const result = await this.session.run(`
            MATCH (q:Question {id: $questionId})-[:HAS_OPTION]->(o:Option)
            RETURN q.text as questionText, q.context as context,
                   collect({
                       letter: o.letter,
                       text: o.text
                   }) as options
        `, { questionId: questionId });

        if (result.records.length === 0) return null;

        const record = result.records[0];
        return {
            id: questionId,
            text: record.get('questionText'),
            context: record.get('context'),
            options: record.get('options')
        };
    }

    // ===== OBTENER SIGUIENTE PREGUNTA O RECOMENDACIÓN =====
    async getNextStep(questionId, selectedLetter) {
        // Buscar si lleva a otra pregunta
        const nextQuestionResult = await this.session.run(`
            MATCH (q:Question {id: $questionId})-[:HAS_OPTION]->(o:Option {letter: $letter})-[:LEADS_TO]->(nextQ:Question)
            RETURN nextQ.id as nextQuestionId
        `, { questionId, letter: selectedLetter });

        if (nextQuestionResult.records.length > 0) {
            const nextQuestionId = nextQuestionResult.records[0].get('nextQuestionId');
            return { type: 'question', id: nextQuestionId };
        }

        // Buscar si lleva a una recomendación
        const recommendationResult = await this.session.run(`
            MATCH (q:Question {id: $questionId})-[:HAS_OPTION]->(o:Option {letter: $letter})-[:RECOMMENDS]->(m:Movie)
            RETURN m.title as title, m.description as description, 
                   m.genre as genre, m.mood as mood, m.recommendation_type as type
        `, { questionId, letter: selectedLetter });

        if (recommendationResult.records.length > 0) {
            const record = recommendationResult.records[0];
            return {
                type: 'recommendation',
                movie: {
                    title: record.get('title'),
                    description: record.get('description'),
                    genre: record.get('genre'),
                    mood: record.get('mood'),
                    recommendation_type: record.get('type')
                }
            };
        }

        return null;
    }

    // ===== GUARDAR SESIÓN DE USUARIO =====
    async saveUserSession(questionPath, finalRecommendation) {
        const sessionId = Date.now().toString();
        
        // Crear sesión de usuario
        await this.session.run(`
            MERGE (u:User {id: $userId})
            CREATE (s:Session {
                id: $sessionId,
                timestamp: datetime(),
                final_recommendation: $finalRecommendation
            })
            MERGE (u)-[:HAS_SESSION]->(s)
        `, {
            userId: this.userId,
            sessionId: sessionId,
            finalRecommendation: finalRecommendation
        });

        // Guardar el camino de respuestas
        for (let i = 0; i < questionPath.length; i++) {
            const step = questionPath[i];
            await this.session.run(`
                MATCH (s:Session {id: $sessionId})
                MATCH (q:Question {id: $questionId})
                MATCH (o:Option {letter: $selectedLetter, question_id: $questionId})
                CREATE (r:Response {
                    step_number: $stepNumber,
                    timestamp: datetime()
                })
                MERGE (s)-[:HAS_RESPONSE]->(r)
                MERGE (r)-[:ANSWERED]->(q)
                MERGE (r)-[:SELECTED]->(o)
            `, {
                sessionId: sessionId,
                questionId: step.questionId,
                selectedLetter: step.selectedOption.letter,
                stepNumber: i + 1
            });
        }
    }

    // ===== ANÁLISIS Y RECOMENDACIONES INTELIGENTES =====
    async getPopularMovies(limit = 10) {
        const result = await this.session.run(`
            MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)-[:SELECTED]->(o:Option)-[:RECOMMENDS]->(m:Movie)
            RETURN m.title as title, count(*) as recommendation_count
            ORDER BY recommendation_count DESC
            LIMIT $limit
        `, { limit: neo4j.int(limit) });

        return result.records.map(record => ({
            title: record.get('title'),
            count: record.get('recommendation_count').toNumber()
        }));
    }

    async getSimilarUsers(userId) {
        const result = await this.session.run(`
            MATCH (u1:User {id: $userId})-[:HAS_SESSION]->(s1:Session)-[:HAS_RESPONSE]->(r1:Response)-[:SELECTED]->(o:Option)
            MATCH (u2:User)-[:HAS_SESSION]->(s2:Session)-[:HAS_RESPONSE]->(r2:Response)-[:SELECTED]->(o)
            WHERE u1 <> u2
            WITH u1, u2, count(o) as common_choices
            RETURN u2.id as similar_user_id, common_choices
            ORDER BY common_choices DESC
            LIMIT 5
        `, { userId });

        return result.records.map(record => ({
            userId: record.get('similar_user_id'),
            commonChoices: record.get('common_choices').toNumber()
        }));
    }

    async getRecommendationsBasedOnSimilarUsers(userId) {
        const result = await this.session.run(`
            MATCH (u1:User {id: $userId})-[:HAS_SESSION]->(s1:Session)-[:HAS_RESPONSE]->(r1:Response)-[:SELECTED]->(o:Option)
            MATCH (u2:User)-[:HAS_SESSION]->(s2:Session)-[:HAS_RESPONSE]->(r2:Response)-[:SELECTED]->(o)
            MATCH (u2)-[:HAS_SESSION]->(s3:Session)
            WHERE u1 <> u2 AND s3.final_recommendation IS NOT NULL
            WITH u1, u2, count(o) as common_choices, s3.final_recommendation as recommendation
            WHERE common_choices >= 2
            RETURN recommendation, count(*) as recommendation_strength
            ORDER BY recommendation_strength DESC
            LIMIT 5
        `, { userId });

        return result.records.map(record => ({
            recommendation: record.get('recommendation'),
            strength: record.get('recommendation_strength').toNumber()
        }));
    }

    // ===== ANÁLISIS DE PATRONES =====
    async getMoodTrends() {
        const result = await this.session.run(`
            MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)-[:SELECTED]->(o:Option)-[:RECOMMENDS]->(m:Movie)-[:HAS_MOOD]->(mood:Mood)
            WITH mood.name as mood_name, count(*) as frequency
            RETURN mood_name, frequency
            ORDER BY frequency DESC
        `);

        return result.records.map(record => ({
            mood: record.get('mood_name'),
            frequency: record.get('frequency').toNumber()
        }));
    }

    async getGenreTrends() {
        const result = await this.session.run(`
            MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)-[:SELECTED]->(o:Option)-[:RECOMMENDS]->(m:Movie)-[:HAS_GENRE]->(g:Genre)
            WITH g.name as genre_name, count(*) as frequency
            RETURN genre_name, frequency
            ORDER BY frequency DESC
        `);

        return result.records.map(record => ({
            genre: record.get('genre_name'),
            frequency: record.get('frequency').toNumber()
        }));
    }

    // ===== INTEGRACIÓN CON TU SISTEMA ACTUAL =====
    async startEnhancedRecommendationSystem() {
        await this.connect();
        
        // Obtener la primera pregunta
        const firstQuestion = await this.getQuestion(1);
        return firstQuestion;
    }

    async processUserChoice(questionId, selectedLetter, questionText, optionText) {
        // Guardar la elección en el camino
        this.questionPath.push({
            questionId: questionId,
            questionText: questionText,
            selectedOption: {
                letter: selectedLetter,
                text: optionText
            }
        });

        // Obtener el siguiente paso
        const nextStep = await this.getNextStep(questionId, selectedLetter);
        
        if (nextStep.type === 'question') {
            // Cargar la siguiente pregunta
            return await this.getQuestion(nextStep.id);
        } else if (nextStep.type === 'recommendation') {
            // Guardar la sesión completa
            await this.saveUserSession(this.questionPath, nextStep.movie.recommendation_type);
            
            // Obtener recomendaciones adicionales basadas en usuarios similares
            const similarRecommendations = await this.getRecommendationsBasedOnSimilarUsers(this.userId);
            
            return {
                type: 'final_recommendation',
                movie: nextStep.movie,
                similarRecommendations: similarRecommendations,
                userPath: this.questionPath
            };
        }
        
        return null;
    }

    // ===== MÉTODOS DE UTILIDAD =====
    generateUserId() {
        return 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    // Estos métodos deben extraer los datos de tu sistema actual
    getMoviesFromCurrentSystem() {
        // Aquí pondrías el objeto recommendations de tu código actual
        return {
            // Ejemplo basado en tu código:
            sitcom_comedy: {
                title: "Friends",
                description: "Una comedia sobre situaciones cotidianas que te hará reír con su humor suave y personajes entrañables.",
                genre: "Comedia Situacional",
                mood: "Relajante • Humor Cotidiano"
            }
            // ... resto de tus películas
        };
    }

    getQuestionsFromCurrentSystem() {
        // Aquí pondrías el objeto questions de tu código actual
        return {
            1: {
                text: "¿Qué te gustaría hacer ahora?",
                options: [
                    { letter: "a", text: "Algo relajante, como descansar o desconectar.", next: 2 },
                    { letter: "b", text: "Algo emocionante, como divertirme o sentir adrenalina.", next: 3 },
                    { letter: "c", text: "Algo que me haga pensar o reflexionar.", next: 4 }
                ]
            }
            // ... resto de tus preguntas
        };
    }
}

// ===== USO EN TU FRONTEND =====
class EnhancedMovieRecommendationSystem {
    constructor() {
        this.neo4jSystem = new Neo4jMovieRecommendationSystem();
        this.currentQuestion = null;
        this.appElement = document.getElementById('app');
        this.progressElement = document.getElementById('progressFill');
    }

    async start() {
        try {
            this.currentQuestion = await this.neo4jSystem.startEnhancedRecommendationSystem();
            this.renderQuestion();
        } catch (error) {
            console.error('Error connecting to Neo4j:', error);
            // Fallback a tu sistema actual sin Neo4j
            this.fallbackToOriginalSystem();
        }
    }

    async selectOption(letter) {
        const selectedOption = this.currentQuestion.options.find(opt => opt.letter === letter);
        if (!selectedOption) return;

        try {
            const result = await this.neo4jSystem.processUserChoice(
                this.currentQuestion.id,
                letter,
                this.currentQuestion.text,
                selectedOption.text
            );

            if (result && result.type === 'final_recommendation') {
                this.showEnhancedRecommendation(result);
            } else if (result) {
                this.currentQuestion = result;
                this.updateProgress();
                this.renderQuestion();
            }
        } catch (error) {
            console.error('Error processing choice:', error);
            // Manejar error y posiblemente usar sistema de respaldo
        }
    }

    showEnhancedRecommendation(result) {
        this.progressElement.style.width = '100%';
        
        const similarRecsHtml = result.similarRecommendations.length > 0 ? `
            <div class="similar-recommendations">
                <h3>🎯 Usuarios similares también disfrutaron:</h3>
                <div class="similar-movies">
                    ${result.similarRecommendations.map(rec => `
                        <div class="similar-movie">${rec.recommendation} (${rec.strength} coincidencias)</div>
                    `).join('')}
                </div>
            </div>
        ` : '';

        this.appElement.innerHTML = `
            <div class="recommendation">
                <h2>🎬 Tu película perfecta es:</h2>
                <div class="movie-card">
                    <div class="movie-title">${result.movie.title}</div>
                    <div class="movie-description">${result.movie.description}</div>
                    <div class="movie-tags">
                        <div class="movie-tag">${result.movie.genre}</div>
                        <div class="movie-tag">${result.movie.mood}</div>
                    </div>
                </div>
                
                ${similarRecsHtml}
                
                <div class="path-summary">
                    <h3>📝 Tu camino emocional:</h3>
                    <div class="path-container">
                        ${this.generatePath(result.userPath)}
                    </div>
                </div>
                
                <button class="restart-btn" onclick="enhancedApp.restart()">
                    🔄 Buscar otra película
                </button>
            </div>
        `;
    }

    fallbackToOriginalSystem() {
        // Usar tu sistema original cuando Neo4j no esté disponible
        const originalSystem = new MovieRecommendationSystem();
        originalSystem.start();
    }

    async restart() {
        this.neo4jSystem.questionPath = [];
        this.progressElement.style.width = '0%';
        await this.start();
    }

    // ... resto de métodos similares a tu clase original
}

// ===== INICIALIZACIÓN =====
let enhancedApp;
document.addEventListener('DOMContentLoaded', () => {
    enhancedApp = new EnhancedMovieRecommendationSystem();
    enhancedApp.start();
});
