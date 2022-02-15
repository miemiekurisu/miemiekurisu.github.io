---
permalink: /spark/spark-submit
layout: default
---
## Spark任务提交

使用spark程序的主要入口是spark-submit和spark-shell。
源代码里位于 `$SPARK_HOME/bin/spark-submit` 和 `$SPARK_HOME/bin/spark-shell`。
其实就是2个shell脚本，主要调用了 `org.apache.spark.deploy.SparkSubmit`，不同的是spark-shell用 `-class` 指定了`org.apache.spark.repl.Main`参数作为submit的主要执行对象。

### 任务提交入口

所以我们的应用端提交程序入口在 `org.apache.spark.deploy.SparkSubmit` 类里，其伴生对象main函数：

```scala
object SparkSubmit extends CommandLineUtils with Logging {

  // Cluster managers 定义了一些集群管理常量
  ...
  // Deploy modes 部署模式常量
  ...
  // Special primary resource names that represent shells rather than application jars.
  ...

    override def main(args: Array[String]): Unit = {
    val submit = new SparkSubmit() {
      self =>

      override protected def parseArguments(args: Array[String]): SparkSubmitArguments = {
        new SparkSubmitArguments(args) {
          override protected def logInfo(msg: => String): Unit = self.logInfo(msg)

          override protected def logWarning(msg: => String): Unit = self.logWarning(msg)
        }
      }

      override protected def logInfo(msg: => String): Unit = printMessage(msg)

      override protected def logWarning(msg: => String): Unit = printMessage(s"Warning: $msg")

      override def doSubmit(args: Array[String]): Unit = {
        try {
          super.doSubmit(args)
        } catch {
          case e: SparkUserAppException =>
            exitFn(e.exitCode)
        }
      }

    }

    submit.doSubmit(args)
  }

```

可以看到主要工作只有1个，稍微改写了 `SparkSubmit` 和其中的 `SparkSubmitArguments` 的日志输出，真正干活的还是`SparkSubmit` 类的 `doSubmit` 方法。

```scala
  def doSubmit(args: Array[String]): Unit = {
    // Initialize logging if it hasn't been done yet. Keep track of whether logging needs to
    // be reset before the application starts.
    // 初始化日志
    val uninitLog = initializeLogIfNecessary(true, silent = true)

    // SparkSubmitArguments 是整个application运行的控制面板，为了处理复杂的参数设置，专门写了一个类。
    // 无论是资源规划还是调优，都可以参考这个类中的配置
    val appArgs = parseArguments(args)
    if (appArgs.verbose) {
      logInfo(appArgs.toString)
    }
    appArgs.action match {
      // 提交给submit方法
      case SparkSubmitAction.SUBMIT => submit(appArgs, uninitLog)
      // ...省略一些其他操作
    }
  }
```

`doSubmit` 处理了传入的参数，并初始化了日志，这个时候才真正提交给`submit`进行处理。

```scala
  /**
   * 偷懒翻译下注释：
   * 用提供的参数提交应用
   * 
   * 有2个步骤:
   * 第一步：准备好启动环境，包括设置classpath、系统参数、应用参数，用指定的cluster manager和deploy mode 
   * 来运行指定的子main class（也就是命令行里指定的 -class 后的类了）。
   * （这句话很短，但是代码很长，注意代码里的prepareSubmitEnviroment方法）
   * 第二步：使用启动环境来装入(这里用了invoke)子main class的main函数，也就是application提交后真正执行的部分。
   */
  @tailrec //<- 注意这里有一个尾递归标识
  private def submit(args: SparkSubmitArguments, uninitLog: Boolean): Unit = {
      // 注意，这里 prepareSubmitEnvironment 做了非常多的操作，包括了启动环境的判断，资源管理器的判断，arg中附带文件的判断等等。
      // 尤其对R做了不少兼容操作，最重要的是此时生成了控制application整个运行过程的sparkConf的初始版本
      // 另外注意这个 childMainClass, 就是从命令行参数里取出来的我们自己开发的application执行类中的mainClass
      // 在后面
    val (childArgs, childClasspath, sparkConf, childMainClass) = prepareSubmitEnvironment(args)

    def doRunMain(): Unit = {
      if (args.proxyUser != null) {
          //这里直接用了hadoop的proxyUser来创建代理用户执行任务
        val proxyUser = UserGroupInformation.createProxyUser(args.proxyUser,
          UserGroupInformation.getCurrentUser())
        try {
          proxyUser.doAs(new PrivilegedExceptionAction[Unit]() {
            override def run(): Unit = {
              runMain(childArgs, childClasspath, sparkConf, childMainClass, args.verbose)
            }
          })
        } catch {
          case e: Exception =>
            // =v=，这里我理解为spark团队针对hadoop鉴权错误的吐槽…… 所以开发hadoop应用的时候可以参考一下这段错误处理
            // Hadoop's AuthorizationException suppresses the exception's stack trace, which
            // makes the message printed to the output by the JVM not very helpful. Instead,
            // detect exceptions with empty stack traces here, and treat them differently.
            if (e.getStackTrace().length == 0) {
              error(s"ERROR: ${e.getClass().getName()}: ${e.getMessage()}")
            } else {
              throw e
            }
        }
      } else {
        runMain(childArgs, childClasspath, sparkConf, childMainClass, args.verbose)
      }
    }

    // Let the main class re-initialize the logging system once it starts.
    if (uninitLog) {
      Logging.uninitialize()
    }

    // 1.3以后默认提交方式为rest，为了保证对面万一不是rest server的情况下也能顺利提交
    // In standalone cluster mode, there are two submission gateways:
    //   (1) The traditional RPC gateway using o.a.s.deploy.Client as a wrapper
    //   (2) The new REST-based gateway introduced in Spark 1.3
    // The latter is the default behavior as of Spark 1.3, but Spark submit will fail over
    // to use the legacy gateway if the master endpoint turns out to be not a REST server.
    if (args.isStandaloneCluster && args.useRest) {
      try {
        logInfo("Running Spark using the REST application submission protocol.")
        doRunMain()
      } catch {
        // Fail over to use the legacy submission gateway
        case e: SubmitRestConnectionException =>
          logWarning(s"Master endpoint ${args.master} was not a REST server. " +
            "Falling back to legacy submission gateway instead.")
          args.useRest = false
          submit(args, false)
      }
    // In all other modes, just run the main class as prepared
    } else {
      doRunMain()
    }
  }
  ```

快进到另起一个线程，用来真正执行任务的`runMain`方法:

```scala
  private def runMain(
      childArgs: Seq[String],
      childClasspath: Seq[String],
      sparkConf: SparkConf,
      childMainClass: String,
      verbose: Boolean): Unit = {
    if (verbose) {
      logInfo(s"Main class:\n$childMainClass")
      logInfo(s"Arguments:\n${childArgs.mkString("\n")}")
      // sysProps may contain sensitive information, so redact before printing
      logInfo(s"Spark config:\n${Utils.redact(sparkConf.getAll.toMap).mkString("\n")}")
      logInfo(s"Classpath elements:\n${childClasspath.mkString("\n")}")
      logInfo("\n")
    }
    // 从当前线程取ClassLoader(都继承了URLClassLoader)，
    // DRIVER_USER_CLASS_PATH_FIRST 对应spark.driver.userClassPathFirst的选项
    // 默认是false，也就是只取 MutableURLClassLoader
    // 区别是ChildFirstURLClassLoader优先使用自己的URL
    val loader =
      if (sparkConf.get(DRIVER_USER_CLASS_PATH_FIRST)) {
        new ChildFirstURLClassLoader(new Array[URL](0),
          Thread.currentThread.getContextClassLoader)
      } else {
        new MutableURLClassLoader(new Array[URL](0),
          Thread.currentThread.getContextClassLoader)
      }
    Thread.currentThread.setContextClassLoader(loader)

    for (jar <- childClasspath) {
        // 加载jar包，优先加载本地，跳过远程和本地不存在的
      addJarToClasspath(jar, loader)
    }

    var mainClass: Class[_] = null

    try {
        // 返回任务的MainClass
      mainClass = Utils.classForName(childMainClass)
    } catch {
      case e: ClassNotFoundException =>
        //... 省略一些日志打印
    }

    // 判断是否可以转换为SparkApplication
    val app: SparkApplication = if (classOf[SparkApplication].isAssignableFrom(mainClass)) {
      mainClass.newInstance().asInstanceOf[SparkApplication]
    } else {
      // ... SPARK-4170  补丁，关于 scala.App trait 的判断，带有scala.App trait 可能工作不正常
    }

    // 递归获取错误信息
    @tailrec
    def findCause(t: Throwable): Throwable = t match {
     // ...
    }

    try {
        // 这下终于到了启动app了
      app.start(childArgs.toArray, sparkConf)
    } catch {
      case t: Throwable =>
        throw findCause(t)
    }
  }

`start` 其实只是Spark程序的一个trait：

```scala
/**
 * Entry point for a Spark application. Implementations must provide a no-argument constructor.
 */
private[spark] trait SparkApplication {

  def start(args: Array[String], conf: SparkConf): Unit

}
```
