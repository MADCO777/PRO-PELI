// ===== CONSULTAS PARA ANÁLISIS =====

// 1. Películas más recomendadas
MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)-[:SELECTED]->(o:Option)-[:RECOMMENDS]->(m:Movie)
RETURN m.title, count(*) as recommendations
ORDER BY recommendations DESC
LIMIT 10;

// 2. Caminos más comunes hacia una película específica
MATCH path = (q1:Question {id: 1})-[:HAS_OPTION*..10]->(:Option)-[:RECOMMENDS]->(m:Movie {title: "Inception"})
RETURN path
LIMIT 5;

// 3. Usuarios con gustos similares
MATCH (u1:User {id: "user_123"})-[:HAS_SESSION]->(s1:Session)-[:HAS_RESPONSE]->(r1:Response)-[:SELECTED]->(o:Option)
MATCH (u2:User)-[:HAS_SESSION]->(s2:Session)-[:HAS_RESPONSE]->(r2:Response)-[:SELECTED]->(o)
WHERE u1 <> u2
WITH u1, u2, count(o) as common_choices
WHERE common_choices >= 3
RETURN u2.id, common_choices
ORDER BY common_choices DESC;

// 4. Géneros más populares por época del año
MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)-[:SELECTED]->(o:Option)-[:RECOMMENDS]->(m:Movie)-[:HAS_GENRE]->(g:Genre)
WHERE s.timestamp > datetime() - duration('P30D')
RETURN g.name, count(*) as frequency
ORDER BY frequency DESC;

// 5. Preguntas que más influyen en las recomendaciones
MATCH (q:Question)-[:HAS_OPTION]->(o:Option)-[:RECOMMENDS]->(m:Movie)
RETURN q.id, q.text, count(DISTINCT m) as unique_recommendations
ORDER BY unique_recommendations DESC;

// 6. Análisis de abandono (usuarios que no completaron)
MATCH (u:User)-[:HAS_SESSION]->(s:Session)
WHERE NOT exists((s)-[:HAS_RESPONSE]->()-[:SELECTED]->()-[:RECOMMENDS]->())
RETURN count(s) as incomplete_sessions;

// 7. Tiempo promedio para completar el cuestionario
MATCH (s:Session)-[:HAS_RESPONSE]->(r:Response)
WITH s, min(r.timestamp) as start_time, max(r.timestamp) as end_time
RETURN avg(duration.between(start_time, end_time).seconds) as avg_completion_time_seconds;

// 8. Recomendaciones por estado de ánimo
MATCH (m:Movie)-[:HAS_MOOD]->(mood:Mood)
MATCH (s:Session)-[:HAS_RESPONSE]->()-[:SELECTED]->()-[:RECOMMENDS]->(m)
RETURN mood.name, count(*) as recommendations
ORDER BY recommendations DESC;

// ===== CONSULTAS PARA OPTIMIZACIÓN =====

// 9. Detectar preguntas redundantes
MATCH (q1:Question)-[:HAS_OPTION]->(o1:Option)-[:LEADS_TO]->(q2:Question)
MATCH (q2)-[:HAS_OPTION]->(o2:Option)-[:RECOMMENDS]->(m:Movie)
MATCH (q1)-[:HAS_OPTION]->(o3:Option)-[:RECOMMENDS]->(m)
WHERE o1 <> o3
RETURN q1.text, q2.text, m.title, "Possible redundancy" as issue;

// 10. Preguntas sin suficientes datos
MATCH (q:Question)
OPTIONAL MATCH (q)-[:HAS_OPTION]->()-[:SELECTED]<-[:HAS_RESPONSE]-()
WITH q, count(*) as response_count
WHERE response_count < 10
RETURN q.id, q.text, response_count
ORDER BY response_count;

// ===== CONSULTAS PARA MEJORAS =====

// 11. Sugerir nuevas películas basadas en gaps
MATCH (g:Genre), (mood:Mood)
WHERE NOT exists((m:Movie)-[:HAS_GENRE]->(g)) OR 
      NOT exists((m:Movie)-[:HAS_MOOD]->(mood))
RETURN g.name as missing_genre, mood.name as missing_mood
LIMIT 10;

// 12. Usuarios más activos
MATCH (u:User)-[:HAS_SESSION]->(s:Session)
RETURN u.id, count(s) as session_count
ORDER BY session_count DESC
LIMIT 10;

// 13. Análisis de satisfacción (si agregas ratings)
MATCH (s:Session)-[:HAS_RESPONSE]->()-[:SELECTED]->()-[:RECOMMENDS]->(m:Movie)
WHERE s.rating IS NOT NULL
RETURN m.title, avg(s.rating) as avg_rating, count(*) as total_ratings
ORDER BY avg_rating DESC;

// ===== CONSULTAS PARA DASHBOARD =====

// 14. Estadísticas generales del sistema
MATCH (u:User) WITH count(u) as total_users
MATCH (s:Session) WITH total_users, count(s) as total_sessions
MATCH (m:Movie) WITH total_users, total_sessions, count(m) as total_movies
MATCH (q:Question) WITH total_users, total_sessions, total_movies, count(q) as total_questions
RETURN total_users, total_sessions, total_movies, total_questions;

// 15. Tendencias por día de la semana
MATCH (s:Session)
WITH s, s.timestamp.dayOfWeek as day_of_week
RETURN day_of_week, count(*) as session_count
ORDER BY day_of_week;
