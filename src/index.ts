// @ts-ignore
import input from "input";
import { Api, sessions, TelegramClient } from "telegram-gifts";
import delay from "delay";
import BigInteger from "big-integer";
import { Telegraf } from "telegraf";

import { env } from "./env.js";

import GetPaymentForm = Api.payments.GetPaymentForm;
import SendStarsForm = Api.payments.SendStarsForm;
import Channel = Api.Channel;
import InputPeerSelf = Api.InputPeerSelf;

interface NewGift {
  id: string;
  supply: number;
  price: number;
}

interface Status {
  new_gifts: NewGift[];
  status: string;
  error: null | string;
  lastUpdate: number;
}

const stringSession = new sessions.StringSession(env.API_SESSION);
const client = new TelegramClient(stringSession, Number(env.API_ID), env.API_HASH, {
  connectionRetries: 5,
});

const telegraf = new Telegraf(env.BOT_TOKEN);

let isBotStopped = false;
let lastMessageId: null | number = null;

await telegraf.telegram.setMyCommands([
  {
    command: "stopbuys",
    description: "Остановить бота",
  },
  {
    command: "startbuys",
    description: "Запустить бота",
  },
]);
telegraf.command("stopbuys", (ctx) => {
  isBotStopped = true;
  lastMessageId = null;
  ctx.reply("бот остановлен");
});
telegraf.command("startbuys", (ctx) => {
  isBotStopped = false;
  ctx.reply("бот запущен");
});

telegraf.launch();

await client
  .start({
    phoneNumber: async () => input.text("Номер телефона:"),
    password: async () => input.text("TFA Password:"),
    phoneCode: async () => input.text("Код телеграмм:"),
    onError: (err) => {
      console.error("Telegram error:", err);
      process.exit(0);
    },
  })
  .then(() => {
    if (!env.API_SESSION) {
      console.log(client.session.save());
    }
  });

let i = 1;
let k = 0;
const me = await client.getMe();
const myId = me.id.toString();

while (true) {
  if (isBotStopped) {
    await delay(1000);
  } else {
    try {
      const response = await fetch("http://38.180.240.96:3001/status");
      const json = (await response.json()) as Status;
      if (json.status !== "ok") {
        await telegraf.telegram.sendMessage(
          myId,
          `!Ошибка в рут-боте!
${json.error}`,
        );
      } else {
        if (!lastMessageId) {
          const message = await telegraf.telegram.sendMessage(
            me.id.toString(),
            `Бот исправен, последнее обновление: ${new Date().toLocaleString()}(UTC+0)`,
          );
          lastMessageId = message.message_id;
        } else if (k % 100 === 0) {
          await telegraf.telegram.editMessageText(
            me.id.toString(),
            lastMessageId,
            undefined,
            `Бот исправен, последнее обновление: ${new Date().toLocaleString()}(UTC+0)`,
          );
        }
        k++;
      }

      if (json.new_gifts.length) {
        await telegraf.telegram.sendMessage(
          myId,
          `Появились новые подарки:
${json.new_gifts.map((x) => `Id: ${x.id}, Supply: ${x.supply}, Price: ${x.price}\n`)}
`,
        );

        const giftsSortedBySupply = json.new_gifts.sort((a, b) => a.supply - b.supply);

        const blockedGiftIds = [
          "5168043875654172773",
          "5170690322832818290",
          "5170521118301225164",
          "5170144170496491616",
          "5170314324215857265",
          "5170564780938756245",
          "6028601630662853006",
          "5170250947678437525",
          "5168103777563050263",
          "5170145012310081615",
          "5170233102089322756",
        ];

        const getGiftQuantity = (supply: number, price: number): number => {
          if (supply <= 5000 && price <= 25000) {
            return 3;
          } else if (supply <= 15000 && price <= 10000) {
            return 5;
          } else if (supply <= 25000 && price <= 5000) {
            return 10;
          } else if (supply <= 40000 && price <= 2500) {
            return 10;          
          } else if (supply <= 80000 && price <= 1000) {
            return 20;          
          } else if (supply <= 150000 && price <= 500) {
            return 30;
          } else if (supply <= 250000 && price <= 250) {
            return 40;          
          } else if (supply <= 500000 && price <= 150) {
            return 50;
          } else if (supply <= 1000000 && price <= 50) {
            return 50;
          }
          return 0;
        };

        const giftToBuy = giftsSortedBySupply.find((gift) => {
          const { supply, price, id } = gift;

          // Skip blocked gift IDs
          if (blockedGiftIds.includes(id)) {
            return false;
          }

          return getGiftQuantity(supply, price) > 0;
        });

        // NEW: Get balance before sending
        const { balance } = await client.invoke(
          new Api.payments.GetStarsTransactions({
            peer: new InputPeerSelf(),
            offset: "",
            limit: 1,
          }),
        );

        if (!giftToBuy) {
          await telegraf.telegram.sendMessage(myId, `Ни один подарок не подошел под фильтр`);
          continue;
        }
        if (balance.amount.toJSNumber() < giftToBuy.price) {
          await telegraf.telegram.sendMessage(
            myId,
            `Нет баланса для покупки. Баланс: ${balance.amount.toJSNumber()}`,
          );
          continue;
        }

        let giftsToSend = getGiftQuantity(giftToBuy.supply, giftToBuy.price);

        let channel: Channel | null = null;
        let targetPeer: Api.InputPeerChannel | Api.InputPeerSelf | Api.InputPeerUser;

        if (env.TARGET === "channel") {
          const updates = (await client.invoke(
            new Api.channels.CreateChannel({
              title: `Gifts ${i}`,
              about: `My favourite collection of gifts ${i}`,
            }),
          )) as Api.Updates;

          channel = updates.chats[0] as Channel;
          targetPeer = new Api.InputPeerChannel({
            channelId: channel.id,
            accessHash: channel.accessHash!,
          });

          await telegraf.telegram.sendMessage(
            myId,
            `Создан канал Gifts ${i}, отгружаем на него ${giftsToSend} подарков с id ${giftToBuy.id}.`,
          );
        } else if (env.TARGET === "user") {
          if (!env.TARGET_USER) {
            await telegraf.telegram.sendMessage(myId, `Ошибка: TARGET_USER не указан для режима user`);
            continue;
          }

          try {
            const user = await client.invoke(new Api.contacts.ResolveUsername({
              username: env.TARGET_USER,
            }));

            if (user.users.length === 0) {
              await telegraf.telegram.sendMessage(myId, `Ошибка: пользователь @${env.TARGET_USER} не найден`);
              continue;
            }

            const targetUser = user.users[0] as Api.User;
            targetPeer = new Api.InputPeerUser({
              userId: targetUser.id,
              accessHash: targetUser.accessHash!,
            });

            await telegraf.telegram.sendMessage(
              myId,
              `Отгружаем пользователю @${env.TARGET_USER} ${giftsToSend} подарков с id ${giftToBuy.id}.`,
            );
          } catch (error) {
            await telegraf.telegram.sendMessage(myId, `Ошибка при поиске пользователя @${env.TARGET_USER}: ${error}`);
            continue;
          }
        } else {
          targetPeer = new Api.InputPeerSelf();
          await telegraf.telegram.sendMessage(
            myId,
            `Отгружаем себе ${giftsToSend} подарков с id ${giftToBuy.id}.`,
          );
        }

        let isError = false;

        while (!isError && giftToBuy && giftsToSend > 0) {
          const invoice = new Api.InputInvoiceStarGift({
            peer: targetPeer,
            giftId: BigInteger(giftToBuy.id),
            hideName: true,
          });

          const paymentForm = await client.invoke(new GetPaymentForm({ invoice }));

          if (
            paymentForm.invoice.className === "Invoice" &&
            paymentForm.invoice.prices.length === 1 &&
            paymentForm.invoice.prices[0].amount.toJSNumber() === giftToBuy.price
          ) {
            await client.invoke(new SendStarsForm({ invoice, formId: paymentForm.formId }));
            giftsToSend--;
          }
        }

        if (env.TARGET === "channel") {
          i++;
        }
      } else {
        await delay(100);
      }
    } catch (error) {
      console.error(error);
      console.log("Some unhandled error, restarting in 3 secs");
      await telegraf.telegram.sendMessage(myId, `Ошибка в slave-боте!`);
      await delay(3000);
    }
  }
}