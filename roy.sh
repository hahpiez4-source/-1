#!/bin/zsh
# ============================================================
# roy.sh — пульт управления роем gbrain на сервере.
#
# Как пользоваться (из этой папки):
#   ./roy.sh          — живые логи роя (бегущей строкой). Выход — Ctrl+C
#   ./roy.sh logs     — то же самое
#   ./roy.sh last     — последние 50 строк (без слежения)
#   ./roy.sh status   — жив ли рой, когда запущен
#   ./roy.sh restart  — перезапустить рой (если завис/сломался)
#   ./roy.sh stop     — остановить рой (бот перестанет отвечать)
#   ./roy.sh start    — запустить рой обратно
#
# В этой Claude-сессии можно так:  ! ./roy.sh status
# ============================================================

SERVER="takopi-server"

case "$1" in
  ""|logs|log|f)
    echo "👀 Живые логи роя (время в UTC, MSK = +3 ч). Выход — Ctrl+C"
    ssh "$SERVER" 'journalctl -u gbrain -f'
    ;;
  last|tail)
    ssh "$SERVER" 'journalctl -u gbrain -n 50 --no-pager'
    ;;
  status|st)
    ssh "$SERVER" 'systemctl status gbrain --no-pager'
    ;;
  restart|r)
    echo "🔄 Перезапускаю рой..."
    ssh "$SERVER" 'systemctl restart gbrain && sleep 3 && systemctl is-active gbrain'
    echo "✅ Готово. Проверь:  ./roy.sh last"
    ;;
  stop|s)
    echo "🛑 Останавливаю рой... (бот перестанет отвечать)"
    ssh "$SERVER" 'systemctl stop gbrain && sleep 2 && systemctl is-active gbrain'
    echo "✅ Рой остановлен. Запустить обратно:  ./roy.sh start"
    ;;
  start|up)
    echo "▶️  Запускаю рой..."
    ssh "$SERVER" 'systemctl start gbrain && sleep 3 && systemctl is-active gbrain'
    echo "✅ Готово. Проверь:  ./roy.sh last"
    ;;
  *)
    echo "Не понял команду «$1». Доступно: logs | last | status | restart | stop | start"
    ;;
esac
