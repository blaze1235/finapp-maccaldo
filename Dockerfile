FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY webapp/ ./webapp/

# Railway injects PORT; app.py reads it (defaults to 8080).
EXPOSE 8080

CMD ["python", "app.py"]
